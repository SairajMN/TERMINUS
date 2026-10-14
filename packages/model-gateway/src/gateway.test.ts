import { describe, expect, it } from "bun:test";
import type { ChatRequest } from "./index";
import { consumeAnthropicStream, mockGateway, toAnthropicParams } from "./index";

const request: ChatRequest = {
  system: "You are TERMINUS.",
  messages: [
    { role: "user", content: [{ type: "text", text: "add a function" }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "reading first" },
        { type: "tool_use", id: "t1", name: "read_file", input: { path: "src/a.ts" } },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t1", content: "export const a = 1;", is_error: false },
      ],
    },
  ],
  tools: [{ name: "read_file", description: "Read a file", input_schema: { type: "object" } }],
};

describe("anthropic parameter conversion", () => {
  it("preserves parts, roles, and tool specs", () => {
    const params = toAnthropicParams(request, { model: "m", maxTokens: 100 });
    expect(params.model).toBe("m");
    expect(params.messages).toHaveLength(3);
    expect(params.messages[1]?.content).toHaveLength(2);
    expect(params.messages[2]?.content[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "t1",
    });
    expect(params.tools[0]?.name).toBe("read_file");
    expect(request.messages[1]?.content).toHaveLength(2);
  });
});

describe("stream assembly", () => {
  it("emits text deltas as they arrive", async () => {
    async function* stream() {
      yield { type: "content_block_delta", delta: { type: "text_delta", text: "hel" } };
      yield { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } };
    }
    const events = [];
    for await (const e of consumeAnthropicStream(stream())) events.push(e);
    expect(events).toEqual([
      { type: "text", text: "hel" },
      { type: "text", text: "lo" },
    ]);
  });

  it("reassembles tool input from partial JSON deltas", async () => {
    async function* stream() {
      yield {
        type: "content_block_start",
        content_block: { type: "tool_use", id: "t9", name: "write_file" },
      };
      yield {
        type: "content_block_delta",
        delta: { type: "input_json_delta", partial_json: '{"path":"src/' },
      };
      yield {
        type: "content_block_delta",
        delta: { type: "input_json_delta", partial_json: 'x.ts","content":"1"}' },
      };
      yield { type: "content_block_stop" };
    }
    const events = [];
    for await (const e of consumeAnthropicStream(stream())) events.push(e);
    expect(events).toEqual([
      { type: "tool_use", id: "t9", name: "write_file", input: { path: "src/x.ts", content: "1" } },
    ]);
  });
});

describe("mock gateway", () => {
  it("records requests and replays scripted responses", async () => {
    let call = 0;
    const gateway = mockGateway(() =>
      call++ === 0 ? [{ type: "text", text: "plan" }] : [{ type: "text", text: "done" }],
    );
    const collect = async () => {
      const out: string[] = [];
      for await (const e of gateway.complete(request)) {
        if (e.type === "text") out.push(e.text);
      }
      return out;
    };
    expect(await collect()).toEqual(["plan"]);
    expect(await collect()).toEqual(["done"]);
    expect(gateway.requests).toHaveLength(2);
    expect(gateway.requests[0]?.system).toBe(request.system);
  });
});
