import { afterEach, describe, expect, it } from "bun:test";
import { tavilySearch, webResearch } from "./index";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.TAVILY_API_KEY;
});

const canned = {
  results: [
    {
      title: "FastAPI Security Docs",
      url: "https://fastapi.tiangolo.com/tutorial/security/",
      content: "Use OAuth2PasswordBearer to protect endpoints.",
      score: 0.97,
    },
  ],
};

let captured: { url?: string; headers?: Record<string, string>; body?: string } = {};
const stubFetch = (payload: unknown, ok = true) => {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    captured = {
      url,
      headers: init?.headers as Record<string, string>,
      body: String(init?.body),
    };
    return {
      ok,
      status: ok ? 200 : 429,
      json: async () => payload,
    } as Response;
  }) as typeof fetch;
};

describe("tavily client", () => {
  it("sends bearer auth and returns normalized results", async () => {
    process.env.TAVILY_API_KEY = "tvly-test";
    stubFetch(canned);
    const results = await tavilySearch("fastapi oauth2", { maxResults: 3 });
    expect(captured.url).toBe("https://api.tavily.com/search");
    expect(captured.headers?.Authorization).toBe("Bearer tvly-test");
    expect(JSON.parse(captured.body ?? "{}")).toMatchObject({
      query: "fastapi oauth2",
      max_results: 3,
    });
    expect(results[0]?.url).toContain("fastapi.tiangolo.com");
  });

  it("fails clearly without a key and on http errors", async () => {
    let message = "";
    try {
      await tavilySearch("x");
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain("TAVILY_API_KEY");

    process.env.TAVILY_API_KEY = "tvly-test";
    stubFetch({}, false);
    message = "";
    try {
      await tavilySearch("x");
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain("429");
  });
});

describe("web_research tool", () => {
  it("formats numbered results with titles and urls", async () => {
    process.env.TAVILY_API_KEY = "tvly-test";
    stubFetch(canned);
    const result = await webResearch.execute(
      { query: "fastapi oauth2" },
      { workspaceRoot: "/tmp", signal: new AbortController().signal },
    );
    expect(result.ok).toBe(true);
    expect(result.output).toContain("1. FastAPI Security Docs");
    expect(result.output).toContain("https://fastapi.tiangolo.com/tutorial/security/");
  });

  it("reports a disabled research tool instead of throwing", async () => {
    const result = await webResearch.execute(
      { query: "x" },
      { workspaceRoot: "/tmp", signal: new AbortController().signal },
    );
    expect(result.ok).toBe(false);
    expect(result.output).toContain("TAVILY_API_KEY");
  });
});
