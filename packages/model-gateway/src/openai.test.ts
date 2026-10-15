import { describe, expect, it } from "bun:test";
import type { ChatRequest } from "./index";
import {
  consumeOpenAIStream,
  nebiusGateway,
  selectGateway,
  toOpenAIMessages,
  toOpenAITools,
} from "./index";

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

describe("openai message conversion", () => {
  it("maps system, tool results, and assistant tool calls", () => {
    const messages = toOpenAIMessages(request);
    expect(messages[0]).toEqual({ role: "system", content: "You are TERMINUS." });
    expect(messages[1]).toEqual({ role: "user", content: "add a function" });
    expect(messages[2]).toMatchObject({
      role: "assistant",
      content: "reading first",
      tool_calls: [{ id: "t1", function: { name: "read_file", arguments: '{"path":"src/a.ts"}' } }],
    });
    expect(messages[3]).toEqual({
      role: "tool",
      tool_call_id: "t1",
      content: "export const a = 1;",
    });
  });

  it("omits tools when the request has none", () => {
    expect(toOpenAITools([])).toEqual([]);
  });

  it("wraps tool specs as openai functions", () => {
    const tools = toOpenAITools(request.tools);
    expect(tools[0]).toMatchObject({
      type: "function",
      function: { name: "read_file", parameters: { type: "object" } },
    });
  });
});

describe("openai stream assembly", () => {
  it("emits text deltas and reassembles fragmented tool calls", async () => {
    async function* stream() {
      yield { choices: [{ delta: { content: "hel" } }] };
      yield {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "c1", function: { name: "write_fi", arguments: '{"pa' } },
              ],
            },
          },
        ],
      };
      yield {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { name: "le", arguments: 'th":"a.ts"}' } }],
            },
          },
        ],
      };
      yield {
        choices: [{ delta: {}, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      };
    }
    const events = [];
    for await (const event of consumeOpenAIStream(stream())) events.push(event);
    expect(events).toEqual([
      { type: "text", text: "hel" },
      { type: "tool_use", id: "c1", name: "write_file", input: { path: "a.ts" } },
      { type: "usage", prompt: 100, completion: 20 },
    ]);
  });

  it("supports parallel tool calls arriving out of order", async () => {
    async function* stream() {
      yield {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 1, id: "b", function: { name: "second", arguments: "{}" } },
                { index: 0, id: "a", function: { name: "first", arguments: "{}" } },
              ],
            },
          },
        ],
      };
    }
    const events = [];
    for await (const event of consumeOpenAIStream(stream())) events.push(event);
    expect(events.map((e) => (e.type === "tool_use" ? e.name : e.type))).toEqual([
      "first",
      "second",
    ]);
  });
});

describe("gateway selection", () => {
  it("picks the requested provider and defaults nebius model", () => {
    const nebius = selectGateway({ provider: "nebius" });
    expect(nebius.label).toContain("nebius");
    expect(nebius.label).toContain("nemotron");
    const anthropic = selectGateway({ provider: "anthropic" });
    expect(anthropic.label).toContain("anthropic");
  });

  it("fails clearly without a nebius key", async () => {
    const previous = process.env.NEBIUS_API_KEY;
    delete process.env.NEBIUS_API_KEY;
    const gateway = nebiusGateway({ apiKey: "" });
    let message = "";
    try {
      for await (const _ of gateway.complete(request)) {
        // drain
      }
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain("NEBIUS_API_KEY");
    if (previous !== undefined) process.env.NEBIUS_API_KEY = previous;
  });
});
