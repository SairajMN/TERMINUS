import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { TerminusRuntimeBridge } from "./bridge";

export interface GuiServerHandle {
  url: string;
  port: number;
  close(): Promise<void>;
}

const readJsonBody = (req: IncomingMessage): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8").trim();
        resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });

const sendJson = (res: ServerResponse, status: number, data: unknown): void => {
  const payload = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(payload);
};

export async function startGuiHttpServer(options: {
  bridge: TerminusRuntimeBridge;
  renderHtml: (bootstrapState: unknown) => string;
  port?: number;
  host?: string;
}): Promise<GuiServerHandle> {
  const host = options.host ?? "127.0.0.1";
  const requestedPort = options.port ?? 0;
  const { bridge } = options;

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${host}`);

    try {
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        const bootstrap = {
          sessions: bridge.listSessions(),
          harnesses: bridge.listHarnessesAndAgents(),
          skills: bridge.listSkills(),
          mcp: bridge.listMcpServers(),
          extensions: bridge.listExtensions(),
          providers: bridge.listProviders(),
          instructions: bridge.getInstructionHierarchy(),
          security: bridge.getSecurityOverview(),
          tools: bridge.getActiveTools(),
        };
        const html = options.renderHtml(bootstrap);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/events") {
        const sessionId = url.searchParams.get("sessionId") ?? "*";
        const afterSeq = Number(url.searchParams.get("afterSeq") ?? "0");
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });

        if (sessionId !== "*") {
          for (const ev of bridge.getExecutionEvents(sessionId, afterSeq)) {
            res.write(`data: ${JSON.stringify(ev)}\n\n`);
          }
        }

        const unsubscribe = bridge.subscribeEvents(sessionId, (ev) => {
          res.write(`data: ${JSON.stringify(ev)}\n\n`);
        });
        req.on("close", unsubscribe);
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/bootstrap") {
        sendJson(res, 200, {
          ok: true,
          sessions: bridge.listSessions(),
          harnesses: bridge.listHarnessesAndAgents(),
          skills: bridge.listSkills(),
          mcp: bridge.listMcpServers(),
          extensions: bridge.listExtensions(),
          providers: bridge.listProviders(),
          instructions: bridge.getInstructionHierarchy(),
          security: bridge.getSecurityOverview(),
          tools: bridge.getActiveTools(),
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/rpc") {
        const body = await readJsonBody(req);
        const method = String(body.method ?? "");
        const params = (body.params ?? {}) as Record<string, unknown>;
        const result = await dispatchBridgeRpc(bridge, method, params);
        sendJson(res, 200, { ok: true, result });
        return;
      }

      sendJson(res, 404, { ok: false, error: `Route not found: ${url.pathname}` });
    } catch (err) {
      sendJson(res, 400, {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(requestedPort, host, () => resolve());
  });

  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : requestedPort;

  return {
    url: `http://${host}:${actualPort}`,
    port: actualPort,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

export async function dispatchBridgeRpc(
  bridge: TerminusRuntimeBridge,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  switch (method) {
    case "createSession":
      return bridge.createSession(params as never);
    case "getSession":
      return bridge.getSession(String(params.sessionId ?? ""));
    case "listSessions":
      return bridge.listSessions(
        typeof params.workspaceRoot === "string" ? params.workspaceRoot : undefined,
      );
    case "sendMessage":
      return bridge.sendMessage(params as never);
    case "pauseExecution":
      return bridge.pauseExecution(String(params.sessionId ?? ""));
    case "resumeExecution":
      return bridge.resumeExecution(String(params.sessionId ?? ""));
    case "stopExecution":
      return bridge.stopExecution(String(params.sessionId ?? ""));
    case "getAgentStatus":
      return bridge.getAgentStatus(String(params.sessionId ?? ""));
    case "getExecutionEvents":
      return bridge.getExecutionEvents(
        String(params.sessionId ?? ""),
        Number(params.afterSeq ?? 0),
      );
    case "getActiveTools":
      return bridge.getActiveTools();
    case "getTaskPlan":
      return bridge.getTaskPlan(String(params.sessionId ?? ""));
    case "getTaskReport":
      return bridge.getTaskReport(String(params.sessionId ?? ""));
    case "getVerificationResults":
      return bridge.getVerificationResults(String(params.sessionId ?? ""));
    case "getTokenUsage":
      return bridge.getTokenUsage(String(params.sessionId ?? ""));
    case "getExecutionBudget":
      return bridge.getExecutionBudget(String(params.sessionId ?? ""));
    case "updateExecutionBudget":
      return bridge.updateExecutionBudget(
        String(params.sessionId ?? ""),
        (params.budget ?? {}) as never,
      );
    case "getFileDiff":
      return bridge.getFileDiff(String(params.sessionId ?? ""));
    case "revertFileModification":
      return bridge.revertFileModification(
        String(params.sessionId ?? ""),
        String(params.filePath ?? ""),
      );
    case "restoreCheckpoint":
      return bridge.restoreCheckpoint(String(params.sessionId ?? ""));
    case "approveAction":
      return bridge.approveAction(params as never);
    case "rejectAction":
      return bridge.rejectAction(params as never);
    case "registerCustomAgent":
      return bridge.registerCustomAgent(params as never);
    case "saveSkill":
      return bridge.saveSkill(params as never);
    case "approveQuarantinedSkill":
      return bridge.approveQuarantinedSkill(
        String(params.name ?? ""),
        String(params.content ?? ""),
      );
    case "registerMcpServer":
      return bridge.registerMcpServer(params.config);
    case "connectMcpServer":
      return bridge.connectMcpServer(String(params.serverId ?? ""));
    case "disconnectMcpServer":
      return bridge.disconnectMcpServer(String(params.serverId ?? ""));
    case "enableExtension":
      return bridge.extensionHost.enableExtension(
        String(params.extensionId ?? ""),
        String(params.workspaceRoot ?? process.cwd()),
      );
    case "disableExtension":
      return bridge.extensionHost.disableExtension(String(params.extensionId ?? ""));
    case "setProviderApiKey":
      await bridge.setProviderApiKey(
        String(params.provider ?? "nebius") as never,
        String(params.apiKey ?? ""),
      );
      return { saved: true };
    default:
      throw new Error(`Unknown AgentRuntimeBridge RPC method: "${method}"`);
  }
}
