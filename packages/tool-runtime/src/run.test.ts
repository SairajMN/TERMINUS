import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redact, runCommand, runShell, sanitizeEnv } from "./index";

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

  it("sanitizes sensitive environment variables from child processes", async () => {
    const rawEnv = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      ANTHROPIC_API_KEY: "sk-ant-12345",
      OPENAI_API_KEY: "sk-proj-67890",
      NEBIUS_API_KEY: "neb-token-111",
      SAFE_VAR: "visible",
    };
    const cleaned = sanitizeEnv(rawEnv);
    expect(cleaned.ANTHROPIC_API_KEY).toBeUndefined();
    expect(cleaned.OPENAI_API_KEY).toBeUndefined();
    expect(cleaned.NEBIUS_API_KEY).toBeUndefined();
    expect(cleaned.SAFE_VAR).toBe("visible");

    // Test that runCommand hides ANTHROPIC_API_KEY from subshells
    const result = await runCommand(
      'node -e "console.log(process.env.ANTHROPIC_API_KEY || \\"hidden\\")"',
      {
        cwd: root,
        env: rawEnv,
      },
    );
    expect(result.output.trim()).toBe("hidden");
  });
});

describe("redaction", () => {
  it("strips common secret shapes", () => {
    const text = [
      "key sk_live_abcdefghij12345",
      "openai sk-proj-abcdefghijklmnop123456",
      "aws AKIAIOSFODNN7EXAMPLE",
      `ghp_${"a".repeat(36)}`,
      `gho_${"b".repeat(36)}`,
      `github_pat_${"c".repeat(82)}`,
      "jwt eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozG4B1sP7v9",
      "https://admin:SuperSecretPassword123@db.internal:5432/app",
    ].join("\n");
    const cleaned = redact(text);
    expect(cleaned).not.toContain("sk_live_");
    expect(cleaned).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(cleaned).not.toContain("SuperSecretPassword123");
    expect(cleaned).toContain("[redacted-key]");
    expect(cleaned).toContain("[redacted-github-token]");
    expect(cleaned).toContain("[redacted-jwt]");
    expect(cleaned).toContain("[redacted-url-credentials]");
  });

  it("redacts secrets found in command output", async () => {
    const result = await runShell.execute({ command: "echo sk_live_abcdefghij12345" }, ctx());
    expect(result.output).toContain("[redacted-key]");
    expect(result.output).not.toContain("sk_live_abcdefghij");
  });
});
