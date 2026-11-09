export interface CompactablePart {
  type: "text" | "tool_use" | "tool_result";
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
}

export interface CompactableMessage {
  role: "user" | "assistant";
  content: CompactablePart[];
}

export interface CompactionStats {
  originalChars: number;
  compactedChars: number;
  savedChars: number;
  estimatedTokensSaved: number;
  compactedResultsCount: number;
}

export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

export const measureMessagesChars = (messages: readonly CompactableMessage[]): number => {
  let total = 0;
  for (const msg of messages) {
    for (const part of msg.content) {
      if (part.type === "text" && part.text) total += part.text.length;
      else if (part.type === "tool_result" && part.content) total += part.content.length;
      else if (part.type === "tool_use") total += JSON.stringify(part.input ?? {}).length + 24;
    }
  }
  return total;
};

/**
 * Compacts message history when total character volume exceeds `maxChars`.
 * - Always preserves message[0] (the initial task + repository map + instructions).
 * - Always preserves the most recent `preserveRecentMessages` messages untouched.
 * - For older messages in the middle window, compresses large `tool_result` payloads
 *   (>400 chars) into concise 2-line provenance summaries so the model retains awareness
 *   of what was read/executed without paying the token tax on every subsequent turn.
 */
export function compactMessages<T extends CompactableMessage>(
  messages: T[],
  options: { maxChars?: number; preserveRecentMessages?: number } = {},
): { messages: T[]; stats: CompactionStats } {
  const maxChars = options.maxChars ?? 48_000;
  const preserveRecent = options.preserveRecentMessages ?? 6;
  const originalChars = measureMessagesChars(messages);

  if (originalChars <= maxChars || messages.length <= preserveRecent + 1) {
    return {
      messages,
      stats: {
        originalChars,
        compactedChars: originalChars,
        savedChars: 0,
        estimatedTokensSaved: 0,
        compactedResultsCount: 0,
      },
    };
  }

  // Map tool_use id -> tool name + brief target
  const toolMeta = new Map<string, string>();
  for (const msg of messages) {
    for (const part of msg.content) {
      if (part.type === "tool_use" && part.id && part.name) {
        const inputObj = (part.input ?? {}) as Record<string, unknown>;
        const target = String(inputObj.path ?? inputObj.command ?? inputObj.query ?? "").slice(
          0,
          80,
        );
        toolMeta.set(part.id, `${part.name}${target ? `(${target})` : ""}`);
      }
    }
  }

  let compactedResultsCount = 0;
  const cutoffIndex = Math.max(1, messages.length - preserveRecent);

  const compacted = messages.map((msg, idx) => {
    if (idx === 0 || idx >= cutoffIndex) return msg;
    const newParts = msg.content.map((part) => {
      if (
        part.type === "tool_result" &&
        typeof part.content === "string" &&
        part.content.length > 400
      ) {
        compactedResultsCount++;
        const label = (part.tool_use_id && toolMeta.get(part.tool_use_id)) || "tool";
        const lines = part.content.split("\n");
        const preview = lines.slice(0, 2).join(" | ").slice(0, 140);
        return {
          ...part,
          content: `[compacted ${label}: ${lines.length} lines, ${part.content.length} chars — preview: ${preview}]`,
        };
      }
      return part;
    });
    return { ...msg, content: newParts };
  });

  const compactedChars = measureMessagesChars(compacted);
  const savedChars = Math.max(0, originalChars - compactedChars);

  return {
    messages: compacted,
    stats: {
      originalChars,
      compactedChars,
      savedChars,
      estimatedTokensSaved: estimateTokens("x".repeat(savedChars)),
      compactedResultsCount,
    },
  };
}
