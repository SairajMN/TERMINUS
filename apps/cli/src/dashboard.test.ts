import { describe, expect, it } from "bun:test";
import {
  approvalCard,
  emptyDash,
  header,
  recordState,
  recordTool,
  reportCard,
  spin,
  timeline,
  toolLine,
} from "./dashboard";

describe("dashboard palette", () => {
  it("renders plain text without a tty", () => {
    const line = header("/repo", "act", "nebius test-model");
    expect(line).toContain("TERMINUS");
    expect(line).toContain("/repo");
    expect(line).not.toContain("\x1b[");
  });

  it("tracks state, tools and time", () => {
    const dash = emptyDash();
    recordState(dash, "planning", 1000);
    recordState(dash, "implementing", 4000);
    recordTool(dash);
    recordTool(dash);
    expect(timeline(dash)).toContain("plan");
    expect(timeline(dash)).toContain("build");
    expect(dash.toolCalls).toBe(2);
  });

  it("draws tool decisions with verdict markers", () => {
    const line = toolLine(
      "read_file",
      { path: "src/a.ts" },
      { verdict: "allow", tier: "read", reason: "ok" },
    );
    expect(line).toContain("read_file");
    expect(line).toContain("src/a.ts");
    const denied = toolLine(
      "run_command",
      { command: "sudo x" },
      { verdict: "deny", tier: "high_impact", reason: "nope" },
    );
    expect(denied).toContain("nope");
  });

  it("asks approvals with options and reports evidence", () => {
    expect(approvalCard("Approve plan", "step 1\nstep 2")).toContain("[y]es");
    const card = reportCard({
      outcome: "completed",
      summary: "Done.",
      changedFiles: ["src/a.ts"],
      commands: [],
      checks: [{ name: "t", command: "npm test", passed: true, output: "ok" }],
      review: { verdict: "clear", summary: "no issues" },
      tokens: { prompt: 10, completion: 4 },
    });
    expect(card).toContain("done");
    expect(card).toContain("[pass]");
    expect(spin(emptyDash())).toBe("…");
  });
});
