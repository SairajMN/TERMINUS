import type { PermissionTier } from "@terminus/shared";
import { z } from "zod";

export interface ExtensionToolContext {
  readonly workspaceRoot: string;
  readonly extensionId: string;
}

export interface ExtensionToolResult {
  ok: boolean;
  output: string;
  metadata?: Record<string, unknown>;
}

export interface ExtensionToolRegistration<TInput = Record<string, unknown>> {
  name: string;
  description: string;
  tier: PermissionTier;
  inputSchema?: Record<string, unknown>;
  execute(
    input: TInput,
    ctx: ExtensionToolContext,
  ): Promise<ExtensionToolResult> | ExtensionToolResult;
}

export interface ExtensionAgentRegistration {
  id: string;
  name: string;
  role: string;
  parentHarness?: string;
  description: string;
  instructions: string[];
  allowedTools: string[];
}

export interface ExtensionSlashCommand {
  command: string;
  description: string;
  expandPrompt(args: string): Promise<string> | string;
}

export interface ExtensionPanelRegistration {
  id: string;
  title: string;
  renderHtml(): Promise<string> | string;
}

export interface PublicSessionEvent {
  type: string;
  sessionId: string;
  timestamp: number;
  summary: string;
}

export interface TerminusExtensionContext {
  readonly extensionId: string;
  readonly workspaceRoot: string;
  readonly logger: {
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
    error(message: string, meta?: Record<string, unknown>): void;
  };
  registerTool<TInput = Record<string, unknown>>(tool: ExtensionToolRegistration<TInput>): void;
  registerAgent(agent: ExtensionAgentRegistration): void;
  registerSkill(relativeSkillPath: string): void;
  registerSlashCommand(cmd: ExtensionSlashCommand): void;
  registerPanel(panel: ExtensionPanelRegistration): void;
  onSessionEvent(handler: (event: PublicSessionEvent) => void): void;
}

export interface TerminusExtensionModule {
  readonly __terminusExtension: true;
  setup(ctx: TerminusExtensionContext): void | Promise<void>;
}

export function defineExtension(
  setup: (ctx: TerminusExtensionContext) => void | Promise<void>,
): TerminusExtensionModule {
  return {
    __terminusExtension: true,
    setup,
  };
}

// Strict IPC message schemas between ExtensionHost and Worker Child Process
export const ExtensionToolResultSchema = z.object({
  ok: z.boolean(),
  output: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const WorkerRpcRequestSchema = z.discriminatedUnion("method", [
  z.object({
    id: z.string(),
    method: z.literal("initialize"),
    params: z.object({
      extensionId: z.string(),
      entrypointPath: z.string(),
      workspaceRoot: z.string(),
    }),
  }),
  z.object({
    id: z.string(),
    method: z.literal("invoke_tool"),
    params: z.object({
      toolName: z.string(),
      input: z.unknown(),
    }),
  }),
  z.object({
    id: z.string(),
    method: z.literal("expand_command"),
    params: z.object({
      command: z.string(),
      args: z.string(),
    }),
  }),
  z.object({
    id: z.string(),
    method: z.literal("render_panel"),
    params: z.object({
      panelId: z.string(),
    }),
  }),
  z.object({
    id: z.string(),
    method: z.literal("ping"),
    params: z.object({}),
  }),
  z.object({
    id: z.string(),
    method: z.literal("shutdown"),
    params: z.object({}),
  }),
]);

export type WorkerRpcRequest = z.infer<typeof WorkerRpcRequestSchema>;

export const WorkerRpcResponseSchema = z.object({
  id: z.string(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().optional(),
});

export type WorkerRpcResponse = z.infer<typeof WorkerRpcResponseSchema>;
