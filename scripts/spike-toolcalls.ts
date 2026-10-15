// Spike A: prove Nemotron on Token Factory returns OpenAI tool_calls.
// Run: bun scripts/spike-toolcalls.ts   (needs NEBIUS_API_KEY in .env or env)
import { nebiusGateway } from "../packages/model-gateway/src/index";

if (!process.env.NEBIUS_API_KEY) {
  console.error("NEBIUS_API_KEY not set");
  process.exit(2);
}

const gateway = nebiusGateway();
const events: string[] = [];
try {
  for await (const event of gateway.complete({
    system: "You are a precise tool-using assistant.",
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: 'Read the file "notes.txt" using the read_file tool.' }],
      },
    ],
    tools: [
      {
        name: "read_file",
        description: "Read a file by path",
        input_schema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    ],
  })) {
    if (event.type === "tool_use") {
      events.push(`tool_use name=${event.name} input=${JSON.stringify(event.input)}`);
    } else if (event.type === "text") {
      events.push(`text ${event.text.slice(0, 80)}`);
    } else if (event.type === "usage") {
      events.push(`usage ${event.prompt}/${event.completion}`);
    }
  }
} catch (error) {
  console.error("SPIKE FAILED:", error);
  process.exit(1);
}

const hasToolCall = events.some((line) => line.startsWith("tool_use name=read_file"));
console.log(events.join("\n"));
if (hasToolCall) {
  console.log("\nSPIKE A PASSED: nemotron returned a structured tool_call");
  process.exit(0);
}
console.log(
  "\nSPIKE A INCONCLUSIVE: no tool_call returned (model may need prompt-based JSON protocol)",
);
process.exit(1);
