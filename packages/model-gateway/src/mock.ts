import type { ChatMessage, ChatRequest, ModelEvent, ModelGateway } from "./types";

export interface MockGateway extends ModelGateway {
  requests: ChatRequest[];
}

const snapshot = (request: ChatRequest): ChatRequest => ({
  ...request,
  messages: request.messages.map(
    (message): ChatMessage => ({ role: message.role, content: [...message.content] }),
  ),
  tools: [...request.tools],
});

export function mockGateway(
  responder: (request: ChatRequest) => ModelEvent[] | Promise<ModelEvent[]>,
): MockGateway {
  const requests: ChatRequest[] = [];
  return {
    requests,
    async *complete(request, signal) {
      requests.push(snapshot(request));
      for (const event of await responder(request)) {
        if (signal?.aborted) throw new Error("aborted");
        yield event;
      }
    },
  };
}
