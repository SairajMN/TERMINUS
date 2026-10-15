import { afterEach, describe, expect, it } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTask } from "@terminus/agent-runtime";
import type { ModelEvent } from "@terminus/model-gateway";
import { mockGateway } from "@terminus/model-gateway";
import type { AgentEvent } from "@terminus/shared";

const originalFetch = globalThis.fetch;
let fixture: string | null = null;

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.TAVILY_API_KEY;
  if (fixture) rmSync(fixture, { recursive: true, force: true });
  fixture = null;
});

const WRONG_IMPL =
  'export const formatForTimezone = (iso, _timeZone) => new Date(iso).toISOString().slice(0, 16).replace("T", " ");\n';

const FIXED_IMPL = [
  "export const formatForTimezone = (iso, timeZone) => {",
  '  const parts = new Intl.DateTimeFormat("en-CA", {',
  "    timeZone,",
  '    year: "numeric",',
  '    month: "2-digit",',
  '    day: "2-digit",',
  '    hour: "2-digit",',
  '    minute: "2-digit",',
  "    hour12: false,",
  "  }).formatToParts(new Date(iso));",
  "  const get = (type) => parts.find((part) => part.type === type)?.value;",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: this writes a JS template literal to disk
  '  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;',
  "};",
  "",
].join("\n");

const PLAN_TEXT = [
  "Plan:",
  "1. Add formatForTimezone(iso, timeZone) to src/date.mjs.",
  "2. Use Intl.DateTimeFormat formatToParts with the requested IANA timeZone.",
  "3. Re-run npm test and correct if assertions fail.",
  "",
  "Sources: [Intl.DateTimeFormat - MDN](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/DateTimeFormat)",
].join("\n");

describe("demo end-to-end: research, implement, fail, fix, verify", () => {
  it("completes the demo task with cited research and passing checks", async () => {
    fixture = mkdtempSync(join(tmpdir(), "terminus-demo-"));
    cpSync(join(import.meta.dir, "..", "examples", "demo-project"), fixture, { recursive: true });

    process.env.TAVILY_API_KEY = "tvly-test";
    globalThis.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({
          results: [
            {
              title: "Intl.DateTimeFormat - MDN",
              url: "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/DateTimeFormat",
              content: "Use formatToParts to extract calendar components for a specific timeZone.",
            },
          ],
        }),
      }) as Response) as unknown as typeof fetch;

    const script: ModelEvent[][] = [
      [
        {
          type: "tool_use",
          id: "r1",
          name: "web_research",
          input: { query: "javascript Intl.DateTimeFormat formatToParts timezone" },
        },
      ],
      [
        { type: "text", text: PLAN_TEXT },
        { type: "usage", prompt: 1200, completion: 180 },
      ],
      [
        {
          type: "tool_use",
          id: "w1",
          name: "write_file",
          input: { path: "src/date.mjs", content: WRONG_IMPL },
        },
      ],
      [{ type: "text", text: "Implemented formatForTimezone." }],
      [
        {
          type: "tool_use",
          id: "e1",
          name: "edit_file",
          input: {
            path: "src/date.mjs",
            old_text: WRONG_IMPL.trimEnd(),
            new_text: FIXED_IMPL.trimEnd(),
          },
        },
      ],
      [{ type: "text", text: "Fixed: the formatter now applies the requested timeZone." }],
    ];
    let call = 0;
    const gateway = mockGateway(() => script[call++] ?? [{ type: "text", text: "stop" }]);

    const events: AgentEvent[] = [];
    const report = await runTask("add formatForTimezone(iso, timeZone) so the test passes", {
      workspaceRoot: fixture,
      gateway,
      approver: async () => ({ approved: true }),
      emit: (event) => events.push(event),
    });

    // Evidence-driven completion: checks actually ran and passed.
    expect(report.outcome).toBe("completed");
    expect(report.checks).toHaveLength(1);
    expect(report.checks[0]?.command).toBe("npm run test");
    expect(report.checks[0]?.passed).toBe(true);
    expect(report.changedFiles).toContain("src/date.mjs");

    // Research was cited in the plan.
    const plan = events.find((event) => event.type === "plan");
    expect(plan?.type === "plan" && plan.text).toContain("developer.mozilla.org");

    // The failure path really happened.
    const states = events.filter((event) => event.type === "state").map((event) => event.to);
    expect(states).toContain("failed_check");
    expect(states).toContain("diagnosing");
    expect(states.at(-1)).toBe("completed");

    // Usage was tracked into the report.
    expect(report.tokens).toEqual({ prompt: 1200, completion: 180 });

    // The planning request exposed web_research to the model.
    expect(gateway.requests[0]?.tools.some((tool) => tool.name === "web_research")).toBe(true);

    // The corrected file is really on disk and really passes.
    const { execSync } = await import("node:child_process");
    const output = execSync("npm test", { cwd: fixture, encoding: "utf8" });
    expect(output).toContain("ok");
  });
});
