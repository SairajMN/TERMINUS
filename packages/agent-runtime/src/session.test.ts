import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mockGateway } from "@terminus/model-gateway";
import { createAgent } from "./index";

const root = mkdtempSync(join(tmpdir(), "terminus-session-"));
const approve = async () => ({ approved: true });

describe("agent session", () => {
  it("keeps conversation context across tasks and clears on reset", async () => {
    let call = 0;
    const gateway = mockGateway(() => {
      call++;
      if (call === 1) return [{ type: "text", text: "Plan: inspect then done." }];
      if (call === 2) return [{ type: "text", text: "Task one answer." }];
      if (call === 3) return [{ type: "text", text: "Plan two: nothing to change." }];
      return [{ type: "text", text: "Task two answer." }];
    });

    const agent = createAgent({
      workspaceRoot: root,
      gateway,
      approver: approve,
      verifyCommands: [],
    });

    await agent.run("first task");
    const second = await agent.run("second task");
    expect(second.outcome).toBe("completed");

    // Task two must see the whole first-task exchange.
    const finalRequest = gateway.requests.at(-1);
    const firstMessage = finalRequest?.messages[0];
    expect(firstMessage?.content[0]?.type).toBe("text");
    expect(firstMessage?.content[0]?.type === "text" && firstMessage.content[0].text).toContain(
      "first task",
    );
    const joined = JSON.stringify(finalRequest?.messages);
    expect(joined).toContain("New task in this session: second task");
    expect(joined).toContain("Task one answer.");

    // Reset starts a fresh conversation.
    agent.reset();
    await agent.run("third task");
    const freshRequest = gateway.requests.at(-1);
    expect(JSON.stringify(freshRequest?.messages)).not.toContain("first task");
    expect(JSON.stringify(freshRequest?.messages)).toContain("third task");
  });
});
