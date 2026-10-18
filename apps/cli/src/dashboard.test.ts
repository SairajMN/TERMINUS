import { describe, expect, it } from "bun:test";
import {
  approvalCard,
  emptyDash,
  header,
  planCard,
  recordState,
  recordTool,
  reportCard,
  resultLine,
  spin,
  stateLine,
  timeline,
  toolLine,
  usageLine,
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

describe("router renderers", () => {
  it("marks state transitions by outcome", () => {
    expect(stateLine("implementing")).toContain("build");
    expect(stateLine("completed")).toContain("done");
    expect(stateLine("failed_check")).toContain("failed");
  });

  it("frames plans with a rule", () => {
    const card = planCard("step one\nstep two");
    expect(card).toContain("─");
    expect(card).toContain("plan");
    expect(card).toContain("step one");
  });

  it("shows per-call usage", () => {
    expect(usageLine(1200, 80)).toContain("1200 in / 80 out");
  });

  it("prints only failing tool results", () => {
    expect(resultLine("run_command", true, "ok")).toBeNull();
    const failed = resultLine("run_command", false, "exit 1\nstack");
    expect(failed).toContain("✕");
    expect(failed).toContain("exit 1");
  });
});

describe("responsive layout", () => {
  it("fits the header to narrow widths", () => {
    const line = header(
      "/Users/sahil/Desktop/HACKATHON/TERMINUS/examples/demo-project",
      "act",
      "nebius nvidia/nemotron-3-super-120b-a12b",
      60,
    );
    expect(line.length).toBeLessThanOrEqual(60);
    expect(line).toContain("act");
    const wide = header("/repo", "act", "nebius model", 120);
    expect(wide).toContain("nebius model");
    expect(wide).toContain("/repo");
  });

  it("compacts the timeline as space runs out", () => {
    const dash = emptyDash();
    recordState(dash, "planning", 1000);
    recordState(dash, "implementing", 4000);
    const narrow = timeline(dash, 40);
    expect(narrow.length).toBeLessThanOrEqual(40);
    expect(narrow).toContain("build");
    const medium = timeline(dash, 70);
    expect(medium.length).toBeLessThanOrEqual(70);
    expect(medium).toContain("research");
    expect(timeline(dash, 120).length).toBeLessThanOrEqual(120);
  });

  it("keeps the verdict when the subject is clipped", () => {
    const line = toolLine(
      "run_command",
      { command: "npm run a-command-name that is certainly far too long" },
      { verdict: "allow", tier: "read", reason: "ok" },
      46,
    );
    expect(line.length).toBeLessThanOrEqual(46);
    expect(line).toContain("allow(read)");
  });

  it("wraps report summaries inside the width", () => {
    const card = reportCard(
      {
        outcome: "completed",
        summary: "implemented the feature and verified everything end to end with all checks",
        changedFiles: ["src/an/extremely/deep/module/path/service.ts"],
        commands: [],
        checks: [
          { name: "t", command: "npm run test:ci -- --coverage", passed: true, output: "ok" },
        ],
      },
      46,
    );
    for (const row of card.split("\n")) expect(row.length).toBeLessThanOrEqual(46);
    expect(card).toContain("[pass]");
  });
});
