// Isolated Extension Worker Subprocess Entrypoint
// Executes untrusted extension code in a separate OS process communicating via JSON-RPC over stdio.
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import {
  type ExtensionAgentRegistration,
  type ExtensionPanelRegistration,
  type ExtensionSlashCommand,
  type ExtensionToolRegistration,
  type TerminusExtensionContext,
  type TerminusExtensionModule,
  WorkerRpcRequestSchema,
} from "@terminus/extension-sdk";

const tools = new Map<string, ExtensionToolRegistration<unknown>>();
const agents = new Map<string, ExtensionAgentRegistration>();
const skills: string[] = [];
const slashCommands = new Map<string, ExtensionSlashCommand>();
const panels = new Map<string, ExtensionPanelRegistration>();

let activeExtensionId = "unknown";
let activeWorkspaceRoot = process.cwd();

const writeLog = (
  level: "info" | "warn" | "error",
  message: string,
  meta?: Record<string, unknown>,
) => {
  process.stderr.write(
    `${JSON.stringify({ __extLog: true, level, message, meta, at: Date.now() })}\n`,
  );
};

const sendResponse = (id: string, ok: boolean, result?: unknown, error?: string) => {
  process.stdout.write(`${JSON.stringify({ id, ok, result, error })}\n`);
};

const rl = createInterface({ input: process.stdin });

rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return;
  }

  const parsed = WorkerRpcRequestSchema.safeParse(raw);
  if (!parsed.success) {
    const fallbackId =
      raw && typeof raw === "object" && "id" in raw ? String((raw as { id: unknown }).id) : "0";
    sendResponse(fallbackId, false, undefined, "Invalid RPC request payload");
    return;
  }

  const req = parsed.data;
  try {
    switch (req.method) {
      case "initialize": {
        activeExtensionId = req.params.extensionId;
        activeWorkspaceRoot = req.params.workspaceRoot;
        const modUrl = pathToFileURL(req.params.entrypointPath).href;
        const imported = (await import(modUrl)) as {
          default?: TerminusExtensionModule | ((ctx: TerminusExtensionContext) => unknown);
          setup?: (ctx: TerminusExtensionContext) => unknown;
        };

        const ctx: TerminusExtensionContext = {
          extensionId: activeExtensionId,
          workspaceRoot: activeWorkspaceRoot,
          logger: {
            info: (m, meta) => writeLog("info", m, meta),
            warn: (m, meta) => writeLog("warn", m, meta),
            error: (m, meta) => writeLog("error", m, meta),
          },
          registerTool: (tool) => {
            tools.set(tool.name, tool as ExtensionToolRegistration<unknown>);
          },
          registerAgent: (agent) => {
            agents.set(agent.id, agent);
          },
          registerSkill: (relPath) => {
            skills.push(relPath);
          },
          registerSlashCommand: (cmd) => {
            slashCommands.set(cmd.command, cmd);
          },
          registerPanel: (panel) => {
            panels.set(panel.id, panel);
          },
          onSessionEvent: () => {},
        };

        if (
          imported.default &&
          typeof imported.default === "object" &&
          "setup" in imported.default
        ) {
          await imported.default.setup(ctx);
        } else if (typeof imported.default === "function") {
          await imported.default(ctx);
        } else if (typeof imported.setup === "function") {
          await imported.setup(ctx);
        } else {
          throw new Error(
            "Extension entrypoint must export default defineExtension(...) or setup()",
          );
        }

        sendResponse(req.id, true, {
          tools: [...tools.values()].map((t) => ({
            name: t.name,
            description: t.description,
            tier: t.tier,
            inputSchema: t.inputSchema ?? { type: "object", properties: {} },
          })),
          agents: [...agents.values()],
          skills,
          slashCommands: [...slashCommands.values()].map((c) => ({
            command: c.command,
            description: c.description,
          })),
          panels: [...panels.values()].map((p) => ({
            id: p.id,
            title: p.title,
          })),
        });
        break;
      }

      case "invoke_tool": {
        const tool = tools.get(req.params.toolName);
        if (!tool) {
          sendResponse(req.id, false, undefined, `Unknown extension tool: ${req.params.toolName}`);
          return;
        }
        const out = await tool.execute(req.params.input, {
          workspaceRoot: activeWorkspaceRoot,
          extensionId: activeExtensionId,
        });
        sendResponse(req.id, true, out);
        break;
      }

      case "expand_command": {
        const cmd = slashCommands.get(req.params.command);
        if (!cmd) {
          sendResponse(req.id, false, undefined, `Unknown slash command: ${req.params.command}`);
          return;
        }
        const expanded = await cmd.expandPrompt(req.params.args);
        sendResponse(req.id, true, { prompt: expanded });
        break;
      }

      case "render_panel": {
        const panel = panels.get(req.params.panelId);
        if (!panel) {
          sendResponse(req.id, false, undefined, `Unknown panel: ${req.params.panelId}`);
          return;
        }
        const html = await panel.renderHtml();
        sendResponse(req.id, true, { html });
        break;
      }

      case "ping": {
        sendResponse(req.id, true, { pong: Date.now() });
        break;
      }

      case "shutdown": {
        sendResponse(req.id, true, { bye: true });
        process.exit(0);
        break;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    writeLog("error", `RPC "${req.method}" failed: ${msg}`);
    sendResponse(req.id, false, undefined, msg);
  }
});
