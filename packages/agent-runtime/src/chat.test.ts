import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelEvent } from "@terminus/model-gateway";
import { mockGateway } from "@terminus/model-gateway";
import { createAgent } from "./index";
import { isTaskLike } from "./prompt";

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "terminus-chat-"));
  writeFileSync(join(root, "notes.txt"), "the deploy uses docker\n");
  return root;
};

describe("chat router", () => {
  it("routes questions and greetings to chat, directives to tasks", () => {
    expect(isTaskLike("add pagination to the users endpoint")).toBe(true);
    expect(isTaskLike("fix the failing auth test")).toBe(true);
    expect(isTaskLike("refactor the billing module into smaller files")).toBe(true);
    expect(isTaskLike("what does the deploy script do?")).toBe(false);
    expect(isTaskLike("why is this test slow")).toBe(false);
    expect(isTaskLike("hi, how are you")).toBe(false);
    expect(isTaskLike("thanks")).toBe(false);
  });

  it("chat answers with no tools and shares context with later tasks", async () => {
    const root = fixture();
    const scripted: ModelEvent[][] = [
      [{ type: "text", text: "The deploy uses docker." }],
      [{ type: "text", text: "Plan: check notes." }],
      [{ type: "text", text: "Done." }],
    ];
    let i = 0;
    const gateway = mockGateway(() => scripted[i++] ?? [{ type: "text", text: "stop" }]);
    const agent = createAgent({
      workspaceRoot: root,
      gateway,
      approver: async () => ({ approved: true }),
      verifyCommands: [],
    });
    const reply = await agent.chat("how do we deploy?");
    expect(reply).toBe("The deploy uses docker.");
    expect(gateway.requests[0]?.tools).toEqual([]);
    const report = await agent.run("confirm the deploy setup", { signal: undefined });
    expect(report.outcome).toBe("completed");
    const taskRequest = gateway.requests.find((request) =>
      request.messages.some((message) =>
        message.content.some(
          (part) => part.type === "text" && part.text.includes("New task in this session"),
        ),
      ),
    );
    expect(taskRequest).toBeDefined();
  });
});
