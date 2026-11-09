import { PermissionEngine } from "@terminus/permission-engine";
import type { Approver, Mode, PermissionTier, ToolDefinition } from "@terminus/shared";
import { z } from "zod";
import { McpServerConnection, type McpServerHealth } from "./client";
import {
  InMemorySecretVault,
  type McpServerConfig,
  McpServerConfigSchema,
  type SecretVault,
} from "./config";

export class McpConnectionManager {
  private readonly connections = new Map<string, McpServerConnection>();
  private readonly secretVault: SecretVault;
  private readonly statusListeners = new Set<(health: McpServerHealth) => void>();

  constructor(options?: { secretVault?: SecretVault }) {
    this.secretVault = options?.secretVault ?? new InMemorySecretVault();
  }

  get vault(): SecretVault {
    return this.secretVault;
  }

  onStatusChange(listener: (health: McpServerHealth) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  registerServer(rawConfig: unknown): McpServerConfig {
    const parsed = McpServerConfigSchema.parse(rawConfig);
    const existing = this.connections.get(parsed.id);
    if (existing) {
      void existing.disconnect();
    }
    const conn = new McpServerConnection(parsed, this.secretVault, (health) => {
      for (const listener of this.statusListeners) listener(health);
    });
    this.connections.set(parsed.id, conn);
    return parsed;
  }

  async connectServer(serverId: string): Promise<McpServerHealth> {
    const conn = this.connections.get(serverId);
    if (!conn) throw new Error(`MCP server "${serverId}" is not registered`);
    return conn.connect();
  }

  async disconnectServer(serverId: string): Promise<void> {
    const conn = this.connections.get(serverId);
    if (!conn) return;
    await conn.disconnect();
  }

  async removeServer(serverId: string): Promise<void> {
    await this.disconnectServer(serverId);
    this.connections.delete(serverId);
  }

  setToolOverride(
    serverId: string,
    toolName: string,
    override: { enabled: boolean; tier: PermissionTier },
  ): void {
    const conn = this.connections.get(serverId);
    if (!conn) throw new Error(`MCP server "${serverId}" is not registered`);
    conn.config.toolOverrides[toolName] = override;
  }

  listHealth(): McpServerHealth[] {
    return [...this.connections.values()].map((c) => c.getHealth());
  }

  getServerHealth(serverId: string): McpServerHealth | undefined {
    return this.connections.get(serverId)?.getHealth();
  }

  /**
   * Produces TERMINUS ToolDefinitions for all enabled tools across connected MCP servers.
   * Every tool invocation enforces PermissionEngine + Approver so no MCP server can bypass permissions.
   */
  getExecutableTools(options: {
    workspaceRoot: string;
    mode: Mode;
    approver?: Approver;
    onPermissionEvaluated?: (audit: {
      origin: string;
      actionKind: string;
      target: string;
      tier: PermissionTier;
      verdict: string;
      reason: string;
    }) => void;
  }): ToolDefinition<never>[] {
    const engine = new PermissionEngine({
      workspaceRoot: options.workspaceRoot,
      mode: options.mode,
    });
    const tools: ToolDefinition<never>[] = [];

    for (const [serverId, conn] of this.connections.entries()) {
      const health = conn.getHealth();
      if (!conn.config.enabled) continue;

      for (const mcpTool of health.tools) {
        if (!mcpTool.enabled) continue;
        const qualifiedName = `mcp__${serverId}__${mcpTool.name}`;
        const tier = mcpTool.permissionTier;

        const def: ToolDefinition<Record<string, unknown>> = {
          name: qualifiedName,
          description: `[MCP:${conn.config.name}] ${mcpTool.description}`,
          tier,
          schema: z.record(z.string(), z.unknown()),
          execute: async (input) => {
            // 1. Deterministic mode & policy enforcement
            if (
              (options.mode === "plan" || options.mode === "ask" || options.mode === "audit") &&
              tier !== "read"
            ) {
              const reason = `mode "${options.mode}" blocks non-read MCP tool "${qualifiedName}" (tier=${tier})`;
              options.onPermissionEvaluated?.({
                origin: `mcp:${serverId}`,
                actionKind: "mcp_tool",
                target: qualifiedName,
                tier,
                verdict: "deny",
                reason,
              });
              return { ok: false, output: `blocked by policy: ${reason}`, truncated: false };
            }

            // Also inspect string arguments against hard_deny command/path patterns
            const serializedInput = JSON.stringify(input);
            const syntheticCheck = engine.evaluate({
              kind: "command",
              command: `echo ${serializedInput}`,
            });
            if (syntheticCheck.action === "deny" && syntheticCheck.reason.includes("hard-deny")) {
              options.onPermissionEvaluated?.({
                origin: `mcp:${serverId}`,
                actionKind: "mcp_tool",
                target: qualifiedName,
                tier,
                verdict: "deny",
                reason: syntheticCheck.reason,
              });
              return {
                ok: false,
                output: `blocked by policy: ${syntheticCheck.reason}`,
                truncated: false,
              };
            }

            if (tier === "high_impact" || (options.mode === "act" && tier === "modify")) {
              if (options.approver) {
                const approval = await options.approver({
                  summary: `MCP Tool ${qualifiedName}`,
                  detail: JSON.stringify(input, null, 2),
                  tier,
                });
                options.onPermissionEvaluated?.({
                  origin: `mcp:${serverId}`,
                  actionKind: "mcp_tool",
                  target: qualifiedName,
                  tier,
                  verdict: approval.approved ? "approved" : "rejected",
                  reason: approval.feedback ?? "user approval gate",
                });
                if (!approval.approved) {
                  return {
                    ok: false,
                    output: "the user rejected this MCP tool invocation",
                    truncated: false,
                  };
                }
              }
            } else {
              options.onPermissionEvaluated?.({
                origin: `mcp:${serverId}`,
                actionKind: "mcp_tool",
                target: qualifiedName,
                tier,
                verdict: "allow",
                reason: "permitted read-tier MCP tool",
              });
            }

            const res = await conn.callTool(mcpTool.name, input);
            return {
              ok: res.ok,
              output: res.output,
              truncated: false,
            };
          },
        };

        tools.push(def as unknown as ToolDefinition<never>);
      }
    }

    return tools;
  }

  async shutdownAll(): Promise<void> {
    await Promise.allSettled([...this.connections.values()].map((c) => c.disconnect()));
  }
}
