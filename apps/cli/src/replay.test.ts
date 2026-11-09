import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "@terminus/session-store";
import { replaySession } from "./replay";

describe("session replay", () => {
  it("reports missing session gracefully", () => {
    const root = mkdtempSync(join(tmpdir(), "terminus-replay-"));
    const store = new SessionStore(join(root, "store.db"));
    const outputs: string[] = [];
    const ok = replaySession(store, "non-existent-id", {
      write: (t) => outputs.push(t),
    });
    expect(ok).toBe(false);
    expect(outputs.join("")).toContain('no session matches id "non-existent-id"');
    store.close();
  });

  it("replays recorded session events in order", () => {
    const root = mkdtempSync(join(tmpdir(), "terminus-replay-"));
    const store = new SessionStore(join(root, "store.db"));
    const id = store.createSession(root, "fix login form validation");

    store.logEvent(id, "state", { from: "queued", to: "investigating" });
    store.logEvent(id, "tool", {
      name: "read_file",
      input: { path: "src/auth.ts" },
      decision: { verdict: "allow", tier: "read" },
    });
    store.logEvent(id, "tool_result", {
      name: "read_file",
      ok: true,
      summary: "export const login = () => {}",
    });
    store.logEvent(id, "approval", {
      question: "run tests",
      approved: true,
    });
    store.logReport(id, {
      outcome: "completed",
      changedFiles: ["src/auth.ts"],
      checks: [{ name: "test", command: "npm test", passed: true, output: "ok" }],
      review: { verdict: "clear", summary: "all clear" },
      summary: "1 check(s) passed",
      commands: ["npm test"],
    });

    const outputs: string[] = [];
    const ok = replaySession(store, id, {
      write: (t) => outputs.push(t),
    });

    expect(ok).toBe(true);
    const rendered = outputs.join("");
    expect(rendered).toContain("TERMINUS SESSION REPLAY");
    expect(rendered).toContain("fix login form validation");
    expect(rendered).toContain("[STATE]");
    expect(rendered).toContain("investigating");
    expect(rendered).toContain("[TOOL]");
    expect(rendered).toContain("read_file");
    expect(rendered).toContain("[RESULT]");
    expect(rendered).toContain("[APPROVE]");
    expect(rendered).toContain("APPROVED");
    expect(rendered).toContain("FINAL REPORT");
    expect(rendered).toContain("completed");
    expect(rendered).toContain("src/auth.ts");

    store.close();
  });
});
