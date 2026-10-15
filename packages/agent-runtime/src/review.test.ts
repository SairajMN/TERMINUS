import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelEvent } from "@terminus/model-gateway";
import { mockGateway } from "@terminus/model-gateway";
import type { Policy } from "@terminus/permission-engine";
import { defaultPolicy, PermissionEngine } from "@terminus/permission-engine";
import type { AgentEvent } from "@terminus/shared";
import { runTask } from "./index";

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "terminus-review-"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "demo", scripts: { test: "node test.mjs" } }),
  );
  writeFileSync(join(root, "test.mjs"), 'console.log("ok");\n');
  return root;
};

const scripted = (script: ModelEvent[][]) => {
  let i = 0;
  return mockGateway(() => script[i++] ?? [{ type: "text", text: "stop" }]);
};

const approve = async () => ({ approved: true });
const DONE = [{ type: "text", text: "Implemented." }] as ModelEvent[];

const statesOf = (events: AgentEvent[]) =>
  events.filter((e) => e.type === "state").map((e) => e.to);

describe("post-change review", () => {
  it("clears a clean diff and records the verdict on the report", async () => {
    const root = fixture();
    const gateway = scripted([
      [{ type: "text", text: "Plan: add src/x.mjs." }],
      [
        {
          type: "tool_use",
          id: "w1",
          name: "write_file",
          input: { path: "src/x.mjs", content: "export const x = 1;\n" },
        },
      ],
      DONE,
      [{ type: "text", text: "Reviewed the diff. verdict: clear" }],
    ]);
    const events: AgentEvent[] = [];
    const report = await runTask("add src/x.mjs", {
      workspaceRoot: root,
      gateway,
      approver: approve,
      emit: (e) => events.push(e),
    });
    expect(report.outcome).toBe("completed");
    expect(report.review?.verdict).toBe("clear");
    expect(statesOf(events)).toContain("reviewing");
    expect(statesOf(events).at(-1)).toBe("completed");
  });

  it("routes major findings back through a fix cycle before clearing", async () => {
    const root = fixture();
    const gateway = scripted([
      [{ type: "text", text: "Plan: add src/x.mjs." }],
      [
        {
          type: "tool_use",
          id: "w1",
          name: "write_file",
          input: { path: "src/x.mjs", content: "export const x = 1;\n" },
        },
      ],
      DONE,
      [{ type: "text", text: "- major: value is never validated\nfix the edge case" }],
      [
        {
          type: "tool_use",
          id: "e1",
          name: "edit_file",
          input: {
            path: "src/x.mjs",
            old_text: "export const x = 1;",
            new_text: "export const x = Number.isFinite(1) ? 1 : 0;",
          },
        },
      ],
      DONE,
      [{ type: "text", text: "Re-reviewed. verdict: clear" }],
    ]);
    const events: AgentEvent[] = [];
    const report = await runTask("add src/x.mjs", {
      workspaceRoot: root,
      gateway,
      approver: approve,
      emit: (e) => events.push(e),
    });
    expect(report.outcome).toBe("completed");
    expect(report.review?.verdict).toBe("clear");
    const states = statesOf(events);
    expect(states.filter((s) => s === "reviewing")).toHaveLength(2);
    expect(states).toContain("diagnosing");
    // review fix actually reached disk
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(join(root, "src", "x.mjs"), "utf8")).toContain("Number.isFinite");
  });
});

describe("audit mode", () => {
  it("reads broadly, changes nothing, and finishes with an audit summary", async () => {
    const root = fixture();
    const gateway = scripted([
      [{ type: "text", text: "critical | auth | missing check | rotate token\naudit complete" }],
    ]);
    const events: AgentEvent[] = [];
    const report = await runTask("audit this project", {
      workspaceRoot: root,
      gateway,
      approver: approve,
      mode: "audit",
      emit: (e) => events.push(e),
      verifyCommands: [],
    });
    expect(report.outcome).toBe("completed");
    expect(report.summary).toBe("Audit produced.");
    expect(report.changedFiles).toEqual([]);
    expect(statesOf(events)).toEqual(["investigating", "completed"]);
    expect(gateway.requests[0]?.tools.some((t) => t.name === "write_file")).toBe(false);
  });

  it("stays read-only at the permission gate", () => {
    const root = fixture();
    const engine = new PermissionEngine({
      workspaceRoot: root,
      mode: "audit",
      policy: defaultPolicy as Policy,
    });
    expect(engine.evaluate({ kind: "file_read", path: join(root, "test.mjs") }).action).toBe(
      "allow",
    );
    expect(engine.evaluate({ kind: "file_write", path: join(root, "x.js") }).action).toBe("deny");
    expect(engine.evaluate({ kind: "command", command: "npm run test" }).action).toBe("deny");
  });
});
