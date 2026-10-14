import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "./index";

const dir = mkdtempSync(join(tmpdir(), "terminus-store-"));
const file = join(dir, "sessions.db");

describe("session store", () => {
  it("persists sessions, state, events, and reports", () => {
    const store = new SessionStore(file);
    const id = store.createSession("/w", "add pagination");
    store.setState(id, "implementing");
    store.logEvent(id, "tool", { name: "write_file", decision: "allow" });
    store.logReport(id, {
      outcome: "completed",
      summary: "done",
      changedFiles: ["a.ts"],
      commands: [],
      checks: [],
    });
    store.close();

    const reopened = new SessionStore(file);
    const sessions = reopened.recentSessions("/w");
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.state).toBe("implementing");
    const events = reopened.eventsOf(id);
    expect(events.map((e) => e.type)).toEqual(["tool", "report"]);
    expect(JSON.parse(events[1]?.payload ?? "{}").outcome).toBe("completed");
    reopened.close();
  });
});
