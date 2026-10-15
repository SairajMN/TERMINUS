import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "@terminus/session-store";
import { buildPriorContext } from "./resume";

describe("resume context", () => {
  it("summarizes a stored session with its final report", () => {
    const store = new SessionStore(join(mkdtempSync(join(tmpdir(), "res-")), "s.db"));
    const id = store.createSession("/w", "add pagination");
    store.logReport(id, {
      outcome: "completed",
      summary: "Done. 2 checks passed.",
      changedFiles: ["src/api.ts"],
      commands: ["npm test"],
      checks: [{ name: "npm test", command: "npm test", passed: true, output: "ok" }],
    });
    const result = buildPriorContext(store, id.slice(0, 8));
    expect(result.error).toBeUndefined();
    expect(result.context).toContain("add pagination");
    expect(result.context).toContain("completed");
    expect(result.context).toContain("src/api.ts");
    expect(result.context).toContain("npm test -> pass");
    store.close();
  });

  it("reports unknown ids without throwing", () => {
    const store = new SessionStore(join(mkdtempSync(join(tmpdir(), "res-")), "s.db"));
    expect(buildPriorContext(store, "nope").error).toContain("no session");
    store.close();
  });
});
