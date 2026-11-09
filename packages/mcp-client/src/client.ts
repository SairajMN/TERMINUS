import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { PermissionTier } from "@terminus/shared";
import { redact } from "@terminus/tool-runtime";
import type { McpServerConfig, SecretVault } from "./config";

export interface McpDiscoveredTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  enabled: boolean;
  permissionTier: PermissionTier;
}

export type McpConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error";

export interface McpServerHealth {
  serverId: string;
  name: string;
  transport: "stdio" | "sse" | "streamable-http";
  status: McpConnectionStatus;
  serverVersion?: string;
  protocolVersion?: string;
  tools: McpDiscoveredTool[];
  lastConnectedAt?: number;
  lastError?: string;
  reconnectAttempts: number;
  logs: { at: number; level: "info" | "warn" | "error"; message: string }[];
}

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const SAFE_INHERITED_ENV_KEYS = ["PATH", "HOME", "USER", "SHELL", "LANG", "TMPDIR", "NODE_ENV"];

export class McpServerConnection {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private status: McpConnectionStatus = "disconnected";
  private serverVersion?: string;
  private protocolVersion?: string;
  private lastConnectedAt?: number;
  private lastError?: string;
  private reconnectAttempts = 0;
  private rpcId = 0;
  private readonly pending = new Map<number, PendingRpc>();
  private discoveredTools: McpDiscoveredTool[] = [];
  private readonly logs: { at: number; level: "info" | "warn" | "error"; message: string }[] = [];

  constructor(
    public config: McpServerConfig,
    private readonly secretVault: SecretVault,
    private readonly onStatusChange?: (health: McpServerHealth) => void,
  ) {}

  private log(level: "info" | "warn" | "error", message: string): void {
    const clean = redact(message);
    this.logs.push({ at: Date.now(), level, message: clean });
    if (this.logs.length > 200) this.logs.shift();
  }

  private setStatus(next: McpConnectionStatus, err?: string): void {
    this.status = next;
    if (err !== undefined) this.lastError = redact(err);
    this.onStatusChange?.(this.getHealth());
  }

  getHealth(): McpServerHealth {
    return {
      serverId: this.config.id,
      name: this.config.name,
      transport: this.config.transport,
      status: this.status,
      serverVersion: this.serverVersion,
      protocolVersion: this.protocolVersion,
      tools: this.discoveredTools.map((t) => ({ ...t })),
      lastConnectedAt: this.lastConnectedAt,
      lastError: this.lastError,
      reconnectAttempts: this.reconnectAttempts,
      logs: [...this.logs],
    };
  }

  async connect(): Promise<McpServerHealth> {
    if (!this.config.enabled) {
      this.setStatus("disconnected");
      return this.getHealth();
    }
    this.setStatus("connecting");
    try {
      if (this.config.transport === "stdio") {
        await this.connectStdio();
      } else {
        await this.connectHttp();
      }
      this.lastConnectedAt = Date.now();
      this.lastError = undefined;
      this.reconnectAttempts = 0;
      this.setStatus("connected");
      this.log(
        "info",
        `Connected to MCP server "${this.config.name}" (${this.discoveredTools.length} tools)`,
      );
      return this.getHealth();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log("error", `Connection failed: ${msg}`);
      this.setStatus("error", msg);
      throw err;
    }
  }

  private async connectStdio(): Promise<void> {
    if (this.config.transport !== "stdio") return;
    await this.disconnect();

    const childEnv: Record<string, string> = {};
    for (const key of SAFE_INHERITED_ENV_KEYS) {
      if (process.env[key]) childEnv[key] = process.env[key] as string;
    }
    Object.assign(childEnv, this.config.env);

    for (const [envVar, secretKey] of Object.entries(this.config.secretEnvRefs)) {
      const val = await this.secretVault.getSecret(secretKey);
      if (val) childEnv[envVar] = val;
    }

    const proc = spawn(this.config.command, this.config.args, {
      cwd: this.config.cwd,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = proc;

    const rl = createInterface({ input: proc.stdout });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const msg = JSON.parse(trimmed) as {
          id?: number;
          result?: unknown;
          error?: { message?: string };
        };
        if (typeof msg.id === "number") {
          const entry = this.pending.get(msg.id);
          if (entry) {
            this.pending.delete(msg.id);
            clearTimeout(entry.timer);
            if (msg.error) {
              entry.reject(new Error(msg.error.message ?? "MCP RPC error"));
            } else {
              entry.resolve(msg.result);
            }
          }
        }
      } catch {
        this.log("info", `[stdout] ${trimmed}`);
      }
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text) this.log("warn", `[stderr] ${text}`);
    });

    proc.on("exit", (code, sig) => {
      for (const [, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error(`MCP server exited unexpectedly (code=${code}, signal=${sig})`));
      }
      this.pending.clear();
      this.proc = null;
      if (this.status === "connected") {
        this.log("error", `MCP server process exited (code=${code}, signal=${sig})`);
        this.setStatus("disconnected", `Process exited with code ${code ?? sig}`);
      }
    });

    const initRes = (await this.sendRpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "terminus", version: "0.3.2" },
    })) as {
      protocolVersion?: string;
      serverInfo?: { name?: string; version?: string };
    };
    this.protocolVersion = initRes?.protocolVersion ?? "2024-11-05";
    this.serverVersion = initRes?.serverInfo?.version ?? "1.0.0";

    const listRes = (await this.sendRpc("tools/list", {})) as {
      tools?: { name: string; description?: string; inputSchema?: Record<string, unknown> }[];
    };
    this.applyDiscoveredTools(listRes?.tools ?? []);
  }

  private async connectHttp(): Promise<void> {
    if (this.config.transport === "stdio") return;
    const initRes = (await this.sendHttpRpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "terminus", version: "0.3.2" },
    })) as {
      protocolVersion?: string;
      serverInfo?: { name?: string; version?: string };
    };
    this.protocolVersion = initRes?.protocolVersion ?? "2024-11-05";
    this.serverVersion = initRes?.serverInfo?.version ?? "1.0.0";

    const listRes = (await this.sendHttpRpc("tools/list", {})) as {
      tools?: { name: string; description?: string; inputSchema?: Record<string, unknown> }[];
    };
    this.applyDiscoveredTools(listRes?.tools ?? []);
  }

  private applyDiscoveredTools(
    rawTools: { name: string; description?: string; inputSchema?: Record<string, unknown> }[],
  ): void {
    this.discoveredTools = rawTools.map((t) => {
      const override = this.config.toolOverrides[t.name];
      const inferredRead = /^(get|list|read|search|inspect|query|fetch)_/i.test(t.name);
      return {
        name: t.name,
        description: t.description ?? `MCP tool ${t.name} from ${this.config.name}`,
        inputSchema: t.inputSchema ?? { type: "object", properties: {} },
        enabled: override?.enabled ?? true,
        permissionTier:
          override?.tier ?? (inferredRead ? "read" : this.config.defaultPermissionTier),
      };
    });
  }

  private sendRpc(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.proc?.stdin.writable) {
        reject(new Error(`MCP server "${this.config.id}" is not running`));
        return;
      }
      const id = ++this.rpcId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request "${method}" timed out after ${this.config.timeoutMs}ms`));
      }, this.config.timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      const payload = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
      this.proc.stdin.write(payload, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  private async sendHttpRpc(method: string, params: unknown): Promise<unknown> {
    if (this.config.transport === "stdio") {
      throw new Error("Expected HTTP transport");
    }
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...this.config.headers,
    };
    for (const [headerName, secretKey] of Object.entries(this.config.secretHeaderRefs)) {
      const val = await this.secretVault.getSecret(secretKey);
      if (val) headers[headerName] = val;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const res = await fetch(this.config.url, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: ++this.rpcId, method, params }),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }
      const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
      if (body.error) {
        throw new Error(body.error.message ?? "MCP HTTP error");
      }
      return body.result;
    } finally {
      clearTimeout(timer);
    }
  }

  async callTool(
    toolName: string,
    args: Record<string, unknown>,
    options?: { maxRetries?: number; retryDelayMs?: number },
  ): Promise<{ ok: boolean; output: string }> {
    const toolMeta = this.discoveredTools.find((t) => t.name === toolName);
    if (!toolMeta?.enabled) {
      return {
        ok: false,
        output: `MCP tool "${toolName}" on server "${this.config.id}" is disabled or not found.`,
      };
    }

    const maxRetries = options?.maxRetries ?? 2;
    const baseDelay = options?.retryDelayMs ?? 40;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        if (this.status !== "connected") {
          this.reconnectAttempts++;
          this.setStatus("reconnecting");
          await this.connect();
        }

        const res =
          this.config.transport === "stdio"
            ? await this.sendRpc("tools/call", { name: toolName, arguments: args })
            : await this.sendHttpRpc("tools/call", { name: toolName, arguments: args });

        const formatted = this.formatToolResponse(res);
        return {
          ok: true,
          output: `<untrusted_mcp_output server="${this.config.id}" tool="${toolName}">\n${redact(formatted)}\n</untrusted_mcp_output>`,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log("warn", `Tool "${toolName}" call failed (attempt ${attempt + 1}): ${msg}`);
        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, baseDelay * 2 ** attempt));
          continue;
        }
        this.setStatus("error", msg);
        return {
          ok: false,
          output: `MCP server "${this.config.id}" failed during "${toolName}": ${redact(msg)}`,
        };
      }
    }

    return { ok: false, output: `MCP tool "${toolName}" failed after retries.` };
  }

  private formatToolResponse(res: unknown): string {
    if (!res || typeof res !== "object") return String(res ?? "");
    const obj = res as { content?: { type?: string; text?: string }[] };
    if (Array.isArray(obj.content)) {
      return obj.content
        .map((c) => (typeof c.text === "string" ? c.text : JSON.stringify(c)))
        .join("\n");
    }
    return JSON.stringify(res, null, 2);
  }

  async disconnect(): Promise<void> {
    if (this.proc) {
      const p = this.proc;
      this.proc = null;
      try {
        p.kill("SIGTERM");
      } catch {}
    }
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error("MCP server disconnected"));
    }
    this.pending.clear();
    this.setStatus("disconnected");
  }
}
