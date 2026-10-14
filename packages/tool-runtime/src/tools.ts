import {
  type Dirent,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { Action, ToolContext, ToolDefinition, ToolResult } from "@terminus/shared";
import { DEFAULT_SKIP_DIRS, isInside } from "@terminus/shared";
import { z } from "zod";
import { redact } from "./redact";
import { runCommand } from "./run";

const MAX_READ_BYTES = 256_000;
const MAX_SEARCH_RESULTS = 200;
const MAX_WALK_FILE_BYTES = 512_000;
const SKIP_DIRS = DEFAULT_SKIP_DIRS;

const ok = (output: string, truncated = false): ToolResult => ({ ok: true, output, truncated });
const fail = (output: string): ToolResult => ({ ok: false, output, truncated: false });

const guardPath = (ctx: ToolContext, path: string): string | ToolResult => {
  const target = resolve(ctx.workspaceRoot, path);
  if (!isInside(ctx.workspaceRoot, target)) {
    return fail(`path resolves outside the workspace: ${path}`);
  }
  return target;
};

const numbered = (text: string, start = 1): string =>
  text
    .split("\n")
    .map((line, i) => `${String(start + i).padStart(4)}  ${line}`)
    .join("\n");

const isBinary = (buffer: Buffer): boolean => buffer.subarray(0, 1024).includes(0);

export const listDir: ToolDefinition<{ path?: string }> = {
  name: "list_dir",
  description: "List a directory inside the workspace. Directories end with /.",
  tier: "read",
  schema: z.object({
    path: z.string().optional().describe("Directory relative to the workspace root"),
  }),
  execute(input, ctx) {
    const target = guardPath(ctx, input.path ?? ".");
    if (typeof target !== "string") return target;
    try {
      const entries = readdirSync(target, { withFileTypes: true })
        .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
        .sort((a, b) => Number(b.endsWith("/")) - Number(a.endsWith("/")) || a.localeCompare(b));
      return ok(entries.join("\n") || "(empty directory)");
    } catch (error) {
      return fail(String(error));
    }
  },
};

export const readFile: ToolDefinition<{ path: string; start_line?: number; end_line?: number }> = {
  name: "read_file",
  description:
    "Read a file from the workspace with line numbers. Optionally restrict to a line range.",
  tier: "read",
  schema: z.object({
    path: z.string().describe("File path relative to the workspace root"),
    start_line: z.number().int().positive().optional(),
    end_line: z.number().int().positive().optional(),
  }),
  execute(input, ctx) {
    const target = guardPath(ctx, input.path);
    if (typeof target !== "string") return target;
    let bytes: Buffer;
    try {
      bytes = readFileSync(target);
    } catch (error) {
      return fail(String(error));
    }
    if (isBinary(bytes)) return fail(`${input.path} is a binary file`);
    const truncated = bytes.length > MAX_READ_BYTES;
    let text = bytes.subarray(0, MAX_READ_BYTES).toString("utf8");
    const start = input.start_line ?? 1;
    if (start > 1 || input.end_line !== undefined) {
      const lines = text.split("\n");
      text = lines.slice(start - 1, input.end_line).join("\n");
    }
    const suffix = truncated ? "\n\n[output truncated]" : "";
    return ok(redact(numbered(text, start) + suffix), truncated);
  },
};

const walk = (root: string, onFile: (path: string) => boolean): void => {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
          stack.push(join(dir, entry.name));
        }
      } else if (onFile(join(dir, entry.name)) === false) {
        return;
      }
    }
  }
};

export const search: ToolDefinition<{ query: string; path?: string; max_results?: number }> = {
  name: "search",
  description:
    "Search workspace files for a regular expression or literal string. Returns path:line: match.",
  tier: "read",
  schema: z.object({
    query: z.string().describe("Regular expression, matched case-insensitively"),
    path: z.string().optional().describe("Subdirectory to search, relative to the workspace root"),
    max_results: z.number().int().positive().max(500).optional(),
  }),
  execute(input, ctx) {
    const base = guardPath(ctx, input.path ?? ".");
    if (typeof base !== "string") return base;
    let pattern: RegExp;
    try {
      pattern = new RegExp(input.query, "i");
    } catch {
      pattern = new RegExp(input.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    }
    const limit = Math.min(input.max_results ?? MAX_SEARCH_RESULTS, MAX_SEARCH_RESULTS);
    const hits: string[] = [];
    let stopped = false;
    walk(base, (file) => {
      let bytes: Buffer;
      try {
        if (statSync(file).size > MAX_WALK_FILE_BYTES) return true;
        bytes = readFileSync(file);
      } catch {
        return true;
      }
      if (isBinary(bytes)) return true;
      const lines = bytes.toString("utf8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] as string;
        if (pattern.test(line)) {
          hits.push(`${relative(ctx.workspaceRoot, file)}:${i + 1}: ${line.trim().slice(0, 300)}`);
          if (hits.length >= limit) {
            stopped = true;
            return false;
          }
        }
      }
      return true;
    });
    if (hits.length === 0) return ok("no matches");
    const suffix = stopped ? `\n\n[stopped at ${limit} results]` : "";
    return ok(redact(hits.join("\n") + suffix), stopped);
  },
};

export const writeFile: ToolDefinition<{ path: string; content: string }> = {
  name: "write_file",
  description: "Create or overwrite a file in the workspace. Parent directories are created.",
  tier: "modify",
  schema: z.object({
    path: z.string().describe("File path relative to the workspace root"),
    content: z.string(),
  }),
  execute(input, ctx) {
    const target = guardPath(ctx, input.path);
    if (typeof target !== "string") return target;
    try {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, input.content);
      return ok(`wrote ${input.content.length} characters to ${input.path}`);
    } catch (error) {
      return fail(String(error));
    }
  },
};

export const editFile: ToolDefinition<{
  path: string;
  old_text: string;
  new_text: string;
  replace_all?: boolean;
}> = {
  name: "edit_file",
  description:
    "Replace an exact string in a file. old_text must match the file content exactly; on failure re-read the file and retry.",
  tier: "modify",
  schema: z.object({
    path: z.string(),
    old_text: z.string().describe("Exact text to find"),
    new_text: z.string().describe("Replacement text"),
    replace_all: z.boolean().optional().describe("Replace every occurrence, not just the first"),
  }),
  execute(input, ctx) {
    const target = guardPath(ctx, input.path);
    if (typeof target !== "string") return target;
    let current: string;
    try {
      current = readFileSync(target, "utf8");
    } catch (error) {
      return fail(String(error));
    }
    const occurrences = current.split(input.old_text).length - 1;
    if (occurrences === 0) {
      return fail(`old_text not found in ${input.path}. Re-read the file before editing.`);
    }
    if (occurrences > 1 && !input.replace_all) {
      return fail(
        `old_text matches ${occurrences} times in ${input.path}. Include more surrounding context or set replace_all.`,
      );
    }
    const updated = input.replace_all
      ? current.split(input.old_text).join(input.new_text)
      : current.replace(input.old_text, input.new_text);
    writeFileSync(target, updated);
    return ok(`applied ${input.replace_all ? occurrences : 1} replacement(s) in ${input.path}`);
  },
};

export const runShell: ToolDefinition<{ command: string; timeout_seconds?: number }> = {
  name: "run_command",
  description:
    "Run a shell command in the workspace directory. Output is capped and redacted; the exit code is included.",
  tier: "high_impact",
  schema: z.object({
    command: z.string(),
    timeout_seconds: z.number().int().positive().max(600).optional(),
  }),
  async execute(input, ctx) {
    const result = await runCommand(input.command, {
      cwd: ctx.workspaceRoot,
      signal: ctx.signal,
      timeoutMs: (input.timeout_seconds ?? 60) * 1000,
    });
    const header = result.timedOut ? "[timed out]\n" : "";
    const footer = result.truncated ? "\n\n[output truncated]" : "";
    const body = `${header}${result.output}${footer}`.trim() || "(no output)";
    return {
      ok: result.exitCode === 0,
      output: `exit code: ${result.exitCode}\n\n${redact(body)}`,
      truncated: result.truncated,
    };
  },
};

const gitTool = (
  name: string,
  description: string,
  command: string,
): ToolDefinition<Record<string, never>> => ({
  name,
  description,
  tier: "read",
  schema: z.object({}),
  async execute(_input, ctx) {
    const result = await runCommand(command, { cwd: ctx.workspaceRoot, signal: ctx.signal });
    return {
      ok: result.exitCode === 0,
      output: redact(result.output || "(no output)"),
      truncated: result.truncated,
    };
  },
});

export const gitStatus = gitTool(
  "git_status",
  "Show concise git working-tree status.",
  "git status --short",
);

export const gitDiff = gitTool(
  "git_diff",
  "Show the unstaged diff of the working tree.",
  "git diff",
);

export const createTools = (): ToolDefinition<never>[] =>
  [
    listDir,
    readFile,
    search,
    writeFile,
    editFile,
    runShell,
    gitStatus,
    gitDiff,
  ] as unknown as ToolDefinition<never>[];

export const actionFor = (toolName: string, input: unknown): Action | null => {
  const value = (input ?? {}) as Record<string, unknown>;
  switch (toolName) {
    case "list_dir":
      return { kind: "file_read", path: String(value.path ?? ".") };
    case "read_file":
      return { kind: "file_read", path: String(value.path) };
    case "search":
      return { kind: "file_read", path: String(value.path ?? ".") };
    case "write_file":
    case "edit_file":
      return { kind: "file_write", path: String(value.path) };
    case "run_command":
      return { kind: "command", command: String(value.command) };
    case "git_status":
      return { kind: "command", command: "git status --short" };
    case "git_diff":
      return { kind: "command", command: "git diff" };
    default:
      return null;
  }
};
