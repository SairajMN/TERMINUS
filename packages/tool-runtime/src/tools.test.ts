import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { actionFor, createTools, editFile, listDir, readFile, search, writeFile } from "./index";

const root = mkdtempSync(join(tmpdir(), "terminus-tools-"));
mkdirSync(join(root, "src"));
writeFileSync(join(root, "src", "a.ts"), "export const alpha = 1;\nexport const beta = 2;\n");
writeFileSync(join(root, "README.md"), "# fixture\n");

const ctx = () => ({ workspaceRoot: root, signal: new AbortController().signal });

async function call(tool: unknown, input: unknown) {
  const def = tool as {
    execute: (i: unknown, c: ReturnType<typeof ctx>) => Promise<{ ok: boolean; output: string }>;
  };
  return def.execute(input, ctx());
}

describe("read tools", () => {
  it("lists directories with folders first", async () => {
    const result = await call(listDir, { path: "." });
    expect(result.ok).toBe(true);
    expect(result.output).toBe("src/\nREADME.md");
  });

  it("reads files with line numbers and ranges", async () => {
    const full = await call(readFile, { path: "src/a.ts" });
    expect(full.output).toContain("1  export const alpha");
    const ranged = await call(readFile, { path: "src/a.ts", start_line: 2, end_line: 2 });
    expect(ranged.output.trim()).toBe("2  export const beta = 2;");
  });

  it("rejects paths outside the workspace", async () => {
    const result = await call(readFile, { path: "../outside.txt" });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("outside the workspace");
  });

  it("searches file contents", async () => {
    const result = await call(search, { query: "beta" });
    expect(result.output).toBe("src/a.ts:2: export const beta = 2;");
    const none = await call(search, { query: "nothing-matches-this" });
    expect(none.output).toBe("no matches");
  });
});

describe("write tools", () => {
  it("writes and edits files", async () => {
    const written = await call(writeFile, { path: "src/b.ts", content: "export const b = 1;\n" });
    expect(written.ok).toBe(true);
    const edited = await call(editFile, {
      path: "src/b.ts",
      old_text: "const b = 1",
      new_text: "const b = 2",
    });
    expect(edited.ok).toBe(true);
    const reread = await call(readFile, { path: "src/b.ts" });
    expect(reread.output).toContain("const b = 2");
  });

  it("fails clearly when the edit anchor is missing or ambiguous", async () => {
    const missing = await call(editFile, {
      path: "src/a.ts",
      old_text: "const gamma",
      new_text: "x",
    });
    expect(missing.ok).toBe(false);
    expect(missing.output).toContain("Re-read the file");
    const ambiguous = await call(editFile, {
      path: "src/a.ts",
      old_text: "const ",
      new_text: "let ",
    });
    expect(ambiguous.ok).toBe(false);
    expect(ambiguous.output).toContain("2 times");
  });
});

describe("action mapping", () => {
  it("maps tools to permission actions", () => {
    expect(actionFor("read_file", { path: "a.ts" })).toEqual({ kind: "file_read", path: "a.ts" });
    expect(actionFor("write_file", { path: "a.ts" })).toEqual({
      kind: "file_write",
      path: "a.ts",
    });
    expect(actionFor("edit_file", { path: "a.ts" })).toEqual({
      kind: "file_write",
      path: "a.ts",
    });
    expect(actionFor("run_command", { command: "ls" })).toEqual({
      kind: "command",
      command: "ls",
    });
    expect(actionFor("git_status", {})).toEqual({
      kind: "command",
      command: "git status --short",
    });
    expect(actionFor("unknown", {})).toBeNull();
  });
});

describe("symlink containment", () => {
  it("blocks writing through a symlink that escapes the workspace", async () => {
    const outside = mkdtempSync(join(tmpdir(), "terminus-outside-"));
    symlinkSync(outside, join(root, "link"));
    const result = await call(writeFile, { path: "link/evil.txt", content: "x" });
    expect(result.ok).toBe(false);
  });
});

describe("tool registry", () => {
  it("exposes every tool exactly once", () => {
    const names = createTools().map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual([
      "list_dir",
      "read_file",
      "search",
      "write_file",
      "edit_file",
      "run_command",
      "git_status",
      "git_diff",
    ]);
  });
});
