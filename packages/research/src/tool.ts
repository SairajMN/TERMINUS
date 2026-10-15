import type { ToolDefinition } from "@terminus/shared";
import { redact } from "@terminus/tool-runtime";
import { z } from "zod";
import { tavilySearch } from "./tavily";

const EXCERPT_CHARS = 600;

export const webResearch: ToolDefinition<{
  query: string;
  max_results?: number;
  domains?: string[];
}> = {
  name: "web_research",
  description:
    "Search the web for official documentation, API references, and guides. Returns numbered results with titles, URLs, and excerpts. Use before implementing unfamiliar technologies; cite the URLs you rely on.",
  tier: "read",
  schema: z.object({
    query: z.string().describe("Focused search query, e.g. framework + feature + version"),
    max_results: z.number().int().positive().max(10).optional(),
    domains: z
      .array(z.string())
      .optional()
      .describe("Prefer these domains, e.g. ['docs.example.com']"),
  }),
  async execute(input, ctx) {
    try {
      const results = await tavilySearch(input.query, {
        maxResults: input.max_results,
        includeDomains: input.domains,
        signal: ctx.signal,
      });
      if (results.length === 0) return { ok: true, output: "no results", truncated: false };
      const output = results
        .map(
          (result, index) =>
            `${index + 1}. ${result.title}\n   ${result.url}\n   ${result.content.slice(0, EXCERPT_CHARS)}`,
        )
        .join("\n\n");
      return { ok: true, output: redact(output), truncated: false };
    } catch (error) {
      return {
        ok: false,
        output: String(error instanceof Error ? error.message : error),
        truncated: false,
      };
    }
  },
};
