import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  actionFor,
  createTools,
  deleteFile,
  editFile,
  FileSnapshotStore,
  fileOutline,
  findSymbol,
  listDir,
  moveFile,
  multiEdit,
  readFile,
  search,
  writeFile,
} from "./index";

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

  it("extracts structural file outlines", async () => {
    const result = await call(fileOutline, { path: "src/a.ts" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("export const alpha = 1;");
    expect(result.output).toContain("export const beta = 2;");
  });

  it("finds symbol definitions and references", async () => {
    const result = await call(findSymbol, { symbol: "alpha" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("definitions (1):");
    expect(result.output).toContain("src/a.ts:1:");
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

  it("applies multi_edit atomically and rolls back if any edit fails", async () => {
    await call(writeFile, {
      path: "src/multi.ts",
      content: "export const x = 1;\nexport const y = 2;\n",
    });
    const failed = await call(multiEdit, {
      path: "src/multi.ts",
      edits: [
        { old_text: "const x = 1", new_text: "const x = 10" },
        { old_text: "non_existent_anchor", new_text: "const z = 30" },
      ],
    });
    expect(failed.ok).toBe(false);
    const untouched = await call(readFile, { path: "src/multi.ts" });
    expect(untouched.output).toContain("const x = 1");

    const succeeded = await call(multiEdit, {
      path: "src/multi.ts",
      edits: [
        { old_text: "const x = 1", new_text: "const x = 10" },
        { old_text: "const y = 2", new_text: "const y = 20" },
      ],
    });
    expect(succeeded.ok).toBe(true);
    const updated = await call(readFile, { path: "src/multi.ts" });
    expect(updated.output).toContain("const x = 10");
    expect(updated.output).toContain("const y = 20");
  });

  it("moves and deletes files within the workspace", async () => {
    await call(writeFile, { path: "src/temp.ts", content: "export const t = 1;\n" });
    const moved = await call(moveFile, { from: "src/temp.ts", to: "src/renamed.ts" });
    expect(moved.ok).toBe(true);
    const deleted = await call(deleteFile, { path: "src/renamed.ts" });
    expect(deleted.ok).toBe(true);
  });

  it("snapshots files and rolls back session modifications", async () => {
    const snapshots = new FileSnapshotStore();
    snapshots.recordBeforeWrite(root, "src/a.ts");
    await call(writeFile, { path: "src/a.ts", content: "export const alpha = 999;\n" });
    snapshots.recordBeforeWrite(root, "src/new-temp.ts");
    await call(writeFile, { path: "src/new-temp.ts", content: "new file\n" });

    const rolled = snapshots.rollbackAll(root);
    expect(rolled.restored).toEqual(["src/a.ts"]);
    expect(rolled.removed).toEqual(["src/new-temp.ts"]);

    const restoredRead = await call(readFile, { path: "src/a.ts" });
    expect(restoredRead.output).toContain("export const alpha = 1;");
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
    expect(actionFor("file_outline", { path: "a.ts" })).toEqual({
      kind: "file_read",
      path: "a.ts",
    });
    expect(actionFor("find_symbol", { symbol: "alpha" })).toEqual({
      kind: "file_read",
      path: ".",
    });
    expect(actionFor("write_file", { path: "a.ts" })).toEqual({
      kind: "file_write",
      path: "a.ts",
    });
    expect(actionFor("edit_file", { path: "a.ts" })).toEqual({
      kind: "file_write",
      path: "a.ts",
    });
    expect(actionFor("multi_edit", { path: "a.ts" })).toEqual({
      kind: "file_write",
      path: "a.ts",
    });
    expect(actionFor("delete_file", { path: "a.ts" })).toEqual({
      kind: "file_write",
      path: "a.ts",
    });
    expect(actionFor("move_file", { from: "a.ts", to: "b.ts" })).toEqual({
      kind: "file_write",
      path: "b.ts",
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
      "file_outline",
      "search",
      "find_symbol",
      "write_file",
      "edit_file",
      "multi_edit",
      "delete_file",
      "move_file",
      "run_command",
      "git_status",
      "git_diff",
      "git_log",
    ]);
  });
});
