import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelEvent } from "@terminus/model-gateway";
import { mockGateway } from "@terminus/model-gateway";
import type { AgentEvent, ApprovalOutcome } from "@terminus/shared";
import { runTask } from "./index";

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "terminus-verify-"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "demo", scripts: { test: "node test.mjs" } }),
  );
  writeFileSync(
    join(root, "test.mjs"),
    'import assert from "node:assert";\nimport { greet } from "./src/greeter.mjs";\nassert.strictEqual(greet("ada"), "hello ada");\nconsole.log("ok");\n',
  );
  return root;
};

const scripted = (script: ModelEvent[][]) => {
  let i = 0;
  return mockGateway(() => script[i++] ?? [{ type: "text", text: "no scripted response left" }]);
};

const approve: () => Promise<ApprovalOutcome> = async () => ({ approved: true });

describe("verification loop", () => {
  it("routes a failed check through diagnosis to a fix", async () => {
    const root = fixture();
    const gateway = scripted([
      [{ type: "text", text: "Plan: add src/greeter.mjs." }],
      [
        {
          type: "tool_use",
          id: "t1",
          name: "write_file",
          input: { path: "src/greeter.mjs", content: "export const greet = (name) => name;\n" },
        },
      ],
      [{ type: "text", text: "Implemented." }],
      [
        {
          type: "tool_use",
          id: "t2",
          name: "edit_file",
          input: {
            path: "src/greeter.mjs",
            old_text: "(name) => name",
            // biome-ignore lint/suspicious/noTemplateCurlyInString: the replacement is a JS template literal
            new_text: "(name) => `hello ${name}`",
          },
        },
      ],
      [{ type: "text", text: "Fixed the greeting." }],
    ]);
    const events: AgentEvent[] = [];
    const report = await runTask("add greet so the test passes", {
      workspaceRoot: root,
      gateway,
      approver: approve,
      emit: (e) => events.push(e),
    });

    expect(report.outcome).toBe("completed");
    expect(report.checks[0]?.passed).toBe(true);
    const states = events.filter((e) => e.type === "state").map((e) => (e as { to: string }).to);
    expect(states).toContain("failed_check");
    expect(states).toContain("diagnosing");
    expect(states.at(-1)).toBe("completed");
  });

  it("blocks policy-violating tool calls and reports them to the model", async () => {
    const root = fixture();
    const gateway = scripted([
      [{ type: "text", text: "Plan: inspect." }],
      [
        {
          type: "tool_use",
          id: "t1",
          name: "run_command",
          input: { command: "sudo rm -rf /tmp/demo" },
        },
      ],
      [{ type: "text", text: "Noted the restriction." }],
    ]);
    const report = await runTask("do something unsafe", {
      workspaceRoot: root,
      gateway,
      approver: approve,
      verifyCommands: [],
    });
    expect(report.outcome).toBe("completed");
    expect(report.changedFiles).toEqual([]);

    const implementTurn = gateway.requests[2];
    const results = implementTurn?.messages.at(-1)?.content ?? [];
    const blocked = results.find((part) => part.type === "tool_result");
    expect(blocked?.type === "tool_result" && blocked.is_error).toBe(true);
    expect(blocked?.type === "tool_result" && blocked.content).toContain("blocked by policy");
  });
});
