import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelEvent } from "@terminus/model-gateway";
import { mockGateway } from "@terminus/model-gateway";
import { SessionStore } from "@terminus/session-store";
import type { AgentEvent, ApprovalOutcome } from "@terminus/shared";
import { runTask } from "./index";

const TEST_MJS = [
  'import assert from "node:assert";',
  'import { greet } from "./src/greeter.mjs";',
  'assert.strictEqual(greet("ada"), "hello ada");',
  'console.log("ok");',
  "",
].join("\n");

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "terminus-loop-"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "demo", scripts: { test: "node test.mjs" } }),
  );
  writeFileSync(join(root, "test.mjs"), TEST_MJS);
  return root;
};

const scripted = (script: ModelEvent[][]) => {
  let i = 0;
  return mockGateway(() => script[i++] ?? [{ type: "text", text: "no scripted response left" }]);
};

const approve: () => Promise<ApprovalOutcome> = async () => ({ approved: true });

// biome-ignore lint/suspicious/noTemplateCurlyInString: the file being written is a JS module that uses a template literal
const GREET_CORRECT = "export const greet = (name) => `hello ${name}`;\n";

describe("agent loop", () => {
  it("plans, implements, verifies, and reports evidence", async () => {
    const root = fixture();
    const gateway = scripted([
      [{ type: "text", text: "Plan: add src/greeter.mjs exporting greet()." }],
      [
        {
          type: "tool_use",
          id: "t1",
          name: "write_file",
          input: { path: "src/greeter.mjs", content: GREET_CORRECT },
        },
      ],
      [{ type: "text", text: "Implemented greet()." }],
    ]);
    const store = new SessionStore(join(root, ".store.db"));
    const events: AgentEvent[] = [];
    const report = await runTask("add a greet module so the test passes", {
      workspaceRoot: root,
      gateway,
      approver: approve,
      emit: (e) => events.push(e),
      store,
    });

    expect(report.outcome).toBe("completed");
    expect(report.changedFiles).toEqual(["src/greeter.mjs"]);
    expect(report.checks).toHaveLength(1);
    expect(report.checks[0]?.passed).toBe(true);
    expect(report.summary).toContain("1 check(s) passed");

    const states = events.filter((e) => e.type === "state").map((e) => (e as { to: string }).to);
    expect(states).toEqual([
      "investigating",
      "planning",
      "awaiting_approval",
      "implementing",
      "verifying",
      "reviewing",
      "completed",
    ]);

    expect(gateway.requests[0]?.tools.some((t) => t.name === "write_file")).toBe(false);
    expect(gateway.requests[2]?.tools.some((t) => t.name === "write_file")).toBe(true);

    const session = store.recentSessions(root)[0];
    expect(session?.state).toBe("completed");
    store.close();
  });

  it("cancels cleanly when the plan is rejected", async () => {
    const root = fixture();
    const gateway = scripted([[{ type: "text", text: "Plan: rewrite everything." }]]);
    const report = await runTask("rewrite the project", {
      workspaceRoot: root,
      gateway,
      approver: async () => ({ approved: false }),
    });
    expect(report.outcome).toBe("cancelled");
    expect(report.changedFiles).toEqual([]);
    expect(gateway.requests).toHaveLength(1);
  });
});
