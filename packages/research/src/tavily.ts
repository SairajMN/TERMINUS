export interface TavilyResult {
  title: string;
  url: string;
  content: string;
  score?: number;
}

interface TavilyResponse {
  results?: {
    title?: string;
    url?: string;
    content?: string;
    score?: number;
  }[];
}

export const tavilySearch = async (
  query: string,
  options: {
    apiKey?: string;
    maxResults?: number;
    searchDepth?: "basic" | "advanced";
    includeDomains?: string[];
    signal?: AbortSignal;
  } = {},
): Promise<TavilyResult[]> => {
  const apiKey = options.apiKey ?? process.env.TAVILY_API_KEY;
  if (!apiKey) {
    throw new Error("TAVILY_API_KEY is not set — web research is disabled");
  }
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query,
      max_results: options.maxResults ?? 5,
      search_depth: options.searchDepth ?? "basic",
      include_answer: false,
      ...(options.includeDomains?.length ? { include_domains: options.includeDomains } : {}),
    }),
    signal: options.signal,
  });
  if (!response.ok) {
    throw new Error(`tavily search failed: HTTP ${response.status}`);
  }
  const payload = (await response.json()) as TavilyResponse;
  return (payload.results ?? []).map((result) => ({
    title: result.title ?? "",
    url: result.url ?? "",
    content: result.content ?? "",
    score: result.score,
  }));
};
