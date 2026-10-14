import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redact, runCommand, runShell } from "./index";

const root = mkdtempSync(join(tmpdir(), "terminus-run-"));
const ctx = () => ({ workspaceRoot: root, signal: new AbortController().signal });

describe("command execution", () => {
  it("captures output and exit codes", async () => {
    const result = await runShell.execute({ command: "echo hello" }, ctx());
    expect(result.ok).toBe(true);
    expect(result.output).toContain("exit code: 0");
    expect(result.output).toContain("hello");
    const failing = await runShell.execute({ command: "exit 3" }, ctx());
    expect(failing.ok).toBe(false);
    expect(failing.output).toContain("exit code: 3");
  });

  it("times out long-running commands", async () => {
    const result = await runCommand("sleep 5", { cwd: root, timeoutMs: 200 });
    expect(result.timedOut).toBe(true);
  });

  it("truncates oversized output", async () => {
    const result = await runCommand("yes x | head -c 200000", { cwd: root, maxBytes: 1000 });
    expect(result.truncated).toBe(true);
    expect(result.output.length).toBeLessThanOrEqual(1000);
  });
});

describe("redaction", () => {
  it("strips common secret shapes", () => {
    const text = [
      "key sk_live_abcdefghij12345",
      "openai sk-proj-abcdefghijklmnop123456",
      "aws AKIAIOSFODNN7EXAMPLE",
      `ghp ${"a".repeat(36)}`,
    ].join("\n");
    const cleaned = redact(text);
    expect(cleaned).not.toContain("sk_live_");
    expect(cleaned).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(cleaned).toContain("[redacted-key]");
  });

  it("redacts secrets found in command output", async () => {
    const result = await runShell.execute({ command: "echo sk_live_abcdefghij12345" }, ctx());
    expect(result.output).toContain("[redacted-key]");
    expect(result.output).not.toContain("sk_live_abcdefghij");
  });
});
