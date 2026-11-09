import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
  type ExtensionAgentRegistration,
  type ExtensionManifest,
  ExtensionToolResultSchema,
  validateExtensionManifest,
  WorkerRpcResponseSchema,
} from "@terminus/extension-sdk";
import { PermissionEngine } from "@terminus/permission-engine";
import {
  type Approver,
  isInside,
  type Mode,
  type PermissionTier,
  type ToolDefinition,
} from "@terminus/shared";
import { redact } from "@terminus/tool-runtime";
import { z } from "zod";

export type ExtensionHealthStatus =
  | "healthy"
  | "disabled"
  | "degraded"
  | "crashed"
  | "circuit_open";

export interface ExtensionLogEntry {
  at: number;
  level: "info" | "warn" | "error";
  message: string;
}

export interface RegisteredExtensionToolMeta {
  name: string;
  description: string;
  tier: PermissionTier;
  inputSchema: Record<string, unknown>;
}

export interface ExtensionRuntimeState {
  manifest: ExtensionManifest;
  directory: string;
  enabled: boolean;
  status: ExtensionHealthStatus;
  failureCount: number;
  circuitOpenedAt?: number;
  lastError?: string;
  pid?: number;
  registeredTools: RegisteredExtensionToolMeta[];
  registeredAgents: ExtensionAgentRegistration[];
  registeredSkills: string[];
  registeredSlashCommands: { command: string; description: string }[];
  registeredPanels: { id: string; title: string }[];
  logs: ExtensionLogEntry[];
}

interface PendingWorkerRpc {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const SAFE_WORKER_ENV_KEYS = ["PATH", "HOME", "TMPDIR", "LANG", "NODE_ENV"];

export class ExtensionHost {
  private readonly extensions = new Map<
    string,
    {
      state: ExtensionRuntimeState;
      proc: ChildProcessWithoutNullStreams | null;
      pending: Map<string, PendingWorkerRpc>;
    }
  >();
  private rpcSeq = 0;
  private readonly maxFailuresBeforeCircuitOpen: number;
  private readonly circuitCooldownMs: number;
  private readonly healthListeners = new Set<(state: ExtensionRuntimeState) => void>();

  constructor(options?: { maxFailuresBeforeCircuitOpen?: number; circuitCooldownMs?: number }) {
    this.maxFailuresBeforeCircuitOpen = options?.maxFailuresBeforeCircuitOpen ?? 3;
    this.circuitCooldownMs = options?.circuitCooldownMs ?? 60_000;
  }

  onHealthChange(listener: (state: ExtensionRuntimeState) => void): () => void {
    this.healthListeners.add(listener);
    return () => this.healthListeners.delete(listener);
  }

  private emitHealth(state: ExtensionRuntimeState): void {
    for (const listener of this.healthListeners) listener(this.cloneState(state));
  }

  private appendLog(
    state: ExtensionRuntimeState,
    level: "info" | "warn" | "error",
    message: string,
  ): void {
    state.logs.push({ at: Date.now(), level, message: redact(message) });
    if (state.logs.length > 250) state.logs.shift();
  }

  private cloneState(state: ExtensionRuntimeState): ExtensionRuntimeState {
    return {
      ...state,
      registeredTools: [...state.registeredTools],
      registeredAgents: [...state.registeredAgents],
      registeredSkills: [...state.registeredSkills],
      registeredSlashCommands: [...state.registeredSlashCommands],
      registeredPanels: [...state.registeredPanels],
      logs: [...state.logs],
    };
  }

  /**
   * Discovers extensions inside a directory (each subfolder containing terminus-extension.json or manifest.json).
   */
  discoverFromDirectory(extensionsRoot: string): {
    loaded: ExtensionManifest[];
    errors: { dir: string; errors: string[] }[];
  } {
    const loaded: ExtensionManifest[] = [];
    const errors: { dir: string; errors: string[] }[] = [];
    if (!existsSync(extensionsRoot)) return { loaded, errors };

    let entries: string[] = [];
    try {
      entries = readdirSync(extensionsRoot);
    } catch {
      return { loaded, errors };
    }

    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      const extDir = join(extensionsRoot, entry);
      const res = this.registerExtensionDirectory(extDir);
      if (res.valid && res.manifest) {
        loaded.push(res.manifest);
      } else if (res.errors.length > 0) {
        errors.push({ dir: extDir, errors: res.errors });
      }
    }

    return { loaded, errors };
  }

  registerExtensionDirectory(extDir: string): {
    valid: boolean;
    manifest?: ExtensionManifest;
    errors: string[];
  } {
    const manifestPath = existsSync(join(extDir, "terminus-extension.json"))
      ? join(extDir, "terminus-extension.json")
      : join(extDir, "manifest.json");
    if (!existsSync(manifestPath)) {
      return { valid: false, errors: ["Missing terminus-extension.json or manifest.json"] };
    }

    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch (err) {
      return {
        valid: false,
        errors: [`Invalid JSON in manifest: ${err instanceof Error ? err.message : String(err)}`],
      };
    }

    const validation = validateExtensionManifest(raw);
    if (!validation.valid || !validation.manifest) {
      return validation;
    }

    const manifest = validation.manifest;
    const entrypointFull = resolve(extDir, manifest.entrypoint);
    if (!isInside(extDir, entrypointFull) || !existsSync(entrypointFull)) {
      return {
        valid: false,
        errors: [`Entrypoint "${manifest.entrypoint}" does not exist inside extension directory`],
      };
    }

    const state: ExtensionRuntimeState = {
      manifest,
      directory: extDir,
      enabled: true,
      status: "disabled",
      failureCount: 0,
      registeredTools: [],
      registeredAgents: [],
      registeredSkills: [],
      registeredSlashCommands: [],
      registeredPanels: [],
      logs: [],
    };

    this.extensions.set(manifest.id, {
      state,
      proc: null,
      pending: new Map(),
    });
    return { valid: true, manifest, errors: [] };
  }

  async activateExtension(
    extensionId: string,
    workspaceRoot: string,
  ): Promise<ExtensionRuntimeState> {
    const record = this.extensions.get(extensionId);
    if (!record) throw new Error(`Extension "${extensionId}" is not registered`);
    const { state } = record;

    if (!state.enabled) {
      state.status = "disabled";
      return this.cloneState(state);
    }

    await this.terminateWorker(extensionId);

    const moduleDir = dirname(fileURLToPath(import.meta.url));
    const workerTs = join(moduleDir, "worker-entry.ts");
    const workerScript = existsSync(workerTs) ? workerTs : join(moduleDir, "worker-entry.js");
    const safeEnv: Record<string, string> = {};
    for (const key of SAFE_WORKER_ENV_KEYS) {
      if (process.env[key]) safeEnv[key] = process.env[key] as string;
    }
    if (process.versions?.electron) {
      safeEnv.ELECTRON_RUN_AS_NODE = "1";
    }

    const proc = spawn(process.execPath, [workerScript], {
      cwd: state.directory,
      env: safeEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    record.proc = proc;
    state.pid = proc.pid;

    const rl = createInterface({ input: proc.stdout });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const parsed = WorkerRpcResponseSchema.safeParse(JSON.parse(trimmed));
        if (!parsed.success) {
          this.appendLog(
            state,
            "warn",
            `Worker sent malformed RPC frame: ${trimmed.slice(0, 160)}`,
          );
          return;
        }
        const msg = parsed.data;
        const pending = record.pending.get(msg.id);
        if (pending) {
          record.pending.delete(msg.id);
          clearTimeout(pending.timer);
          if (msg.ok) pending.resolve(msg.result);
          else pending.reject(new Error(msg.error ?? "Extension worker error"));
        }
      } catch {
        this.appendLog(state, "info", `[stdout] ${trimmed}`);
      }
    });

    const errRl = createInterface({ input: proc.stderr });
    errRl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const logObj = JSON.parse(trimmed) as {
          __extLog?: boolean;
          level?: "info" | "warn" | "error";
          message?: string;
        };
        if (logObj.__extLog && logObj.message) {
          this.appendLog(state, logObj.level ?? "info", logObj.message);
          return;
        }
      } catch {}
      this.appendLog(state, "warn", `[stderr] ${trimmed}`);
    });

    proc.on("exit", (code, sig) => {
      record.proc = null;
      state.pid = undefined;
      for (const [, p] of record.pending) {
        clearTimeout(p.timer);
        p.reject(
          new Error(`Extension "${extensionId}" worker crashed (code=${code}, signal=${sig})`),
        );
      }
      record.pending.clear();

      if (state.enabled && state.status !== "disabled") {
        this.recordFailure(state, `Worker process exited (code=${code}, signal=${sig})`, true);
      }
    });

    try {
      const initResult = (await this.sendWorkerRpc(extensionId, "initialize", {
        extensionId,
        entrypointPath: resolve(state.directory, state.manifest.entrypoint),
        workspaceRoot,
      })) as {
        tools?: RegisteredExtensionToolMeta[];
        agents?: ExtensionAgentRegistration[];
        skills?: string[];
        slashCommands?: { command: string; description: string }[];
        panels?: { id: string; title: string }[];
      };

      const caps = new Set(state.manifest.capabilities);
      state.registeredTools = caps.has("tools") ? (initResult.tools ?? []) : [];
      state.registeredAgents = caps.has("agents") ? (initResult.agents ?? []) : [];
      state.registeredSkills = caps.has("skills") ? (initResult.skills ?? []) : [];
      state.registeredSlashCommands = caps.has("slash_commands")
        ? (initResult.slashCommands ?? [])
        : [];
      state.registeredPanels = caps.has("ui_panels") ? (initResult.panels ?? []) : [];

      state.status = "healthy";
      state.lastError = undefined;
      this.appendLog(
        state,
        "info",
        `Activated extension "${state.manifest.name}" v${state.manifest.version} (PID ${proc.pid})`,
      );
      this.emitHealth(state);
      return this.cloneState(state);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.recordFailure(state, `Initialization failed: ${msg}`, true);
      await this.terminateWorker(extensionId);
      return this.cloneState(state);
    }
  }

  private recordFailure(state: ExtensionRuntimeState, errorMsg: string, crashed = false): void {
    state.failureCount++;
    state.lastError = redact(errorMsg);
    this.appendLog(state, "error", errorMsg);

    if (state.failureCount >= this.maxFailuresBeforeCircuitOpen) {
      state.status = "circuit_open";
      state.circuitOpenedAt = Date.now();
      this.appendLog(
        state,
        "error",
        `Circuit breaker OPEN for "${state.manifest.id}" after ${state.failureCount} failures.`,
      );
    } else {
      state.status = crashed ? "crashed" : "degraded";
    }
    this.emitHealth(state);
  }

  private sendWorkerRpc(
    extensionId: string,
    method: "initialize" | "invoke_tool" | "expand_command" | "render_panel" | "ping" | "shutdown",
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const record = this.extensions.get(extensionId);
    if (!record?.proc?.stdin.writable) {
      return Promise.reject(new Error(`Extension "${extensionId}" worker is not running`));
    }
    const { state, proc, pending } = record;
    const id = `rpc-${++this.rpcSeq}`;
    const timeoutMs = state.manifest.timeoutMs;

    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        // Kill hung worker process so an infinite loop cannot freeze the host
        try {
          proc.kill("SIGKILL");
        } catch {}
        record.proc = null;
        state.pid = undefined;
        const timeoutErr = new Error(
          `Extension "${extensionId}" exceeded timeout of ${timeoutMs}ms during "${method}"`,
        );
        this.recordFailure(state, timeoutErr.message, false);
        rejectPromise(timeoutErr);
      }, timeoutMs);

      pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer });
      const payload = `${JSON.stringify({ id, method, params })}\n`;
      proc.stdin.write(payload, (err) => {
        if (err) {
          clearTimeout(timer);
          pending.delete(id);
          rejectPromise(err);
        }
      });
    });
  }

  async invokeExtensionTool(
    extensionId: string,
    toolName: string,
    input: unknown,
    workspaceRoot: string,
  ): Promise<{ ok: boolean; output: string }> {
    const record = this.extensions.get(extensionId);
    if (!record) {
      return { ok: false, output: `Extension "${extensionId}" is not installed.` };
    }
    const { state } = record;

    if (!state.enabled || state.status === "disabled") {
      return {
        ok: false,
        output: `Extension "${extensionId}" is currently disabled.`,
      };
    }

    if (state.status === "circuit_open") {
      const elapsed = Date.now() - (state.circuitOpenedAt ?? 0);
      if (elapsed < this.circuitCooldownMs) {
        return {
          ok: false,
          output: `Extension "${extensionId}" is temporarily unavailable (circuit breaker open: ${state.lastError ?? "repeated failures"}).`,
        };
      }
      // Cooldown elapsed: attempt half-open recovery
      state.failureCount = Math.max(0, this.maxFailuresBeforeCircuitOpen - 1);
    }

    if (!record.proc) {
      await this.activateExtension(extensionId, workspaceRoot);
      if (!record.proc || state.status === "circuit_open" || state.status === "crashed") {
        return {
          ok: false,
          output: `Extension "${extensionId}" failed to start: ${state.lastError ?? "worker unavailable"}`,
        };
      }
    }

    try {
      const rawOut = await this.sendWorkerRpc(extensionId, "invoke_tool", {
        toolName,
        input,
      });

      const validated = ExtensionToolResultSchema.safeParse(rawOut);
      if (!validated.success) {
        const schemaMsg = `Extension "${extensionId}" tool "${toolName}" returned malformed output (${validated.error.issues.map((i) => i.message).join(", ")})`;
        this.recordFailure(state, schemaMsg, false);
        return {
          ok: false,
          output: schemaMsg,
        };
      }

      // Reset consecutive failures on clean invocation
      state.failureCount = 0;
      if (state.status !== "healthy") {
        state.status = "healthy";
        this.emitHealth(state);
      }

      return {
        ok: validated.data.ok,
        output: redact(validated.data.output),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        output: `Extension "${extensionId}" tool "${toolName}" failed: ${redact(msg)}`,
      };
    }
  }

  async disableExtension(extensionId: string): Promise<ExtensionRuntimeState> {
    const record = this.extensions.get(extensionId);
    if (!record) throw new Error(`Extension "${extensionId}" is not registered`);
    record.state.enabled = false;
    record.state.status = "disabled";
    await this.terminateWorker(extensionId);
    this.appendLog(record.state, "info", `Extension "${extensionId}" disabled by user.`);
    this.emitHealth(record.state);
    return this.cloneState(record.state);
  }

  async enableExtension(
    extensionId: string,
    workspaceRoot: string,
  ): Promise<ExtensionRuntimeState> {
    const record = this.extensions.get(extensionId);
    if (!record) throw new Error(`Extension "${extensionId}" is not registered`);
    record.state.enabled = true;
    record.state.failureCount = 0;
    record.state.circuitOpenedAt = undefined;
    return this.activateExtension(extensionId, workspaceRoot);
  }

  private async terminateWorker(extensionId: string): Promise<void> {
    const record = this.extensions.get(extensionId);
    if (!record?.proc) return;
    const proc = record.proc;
    record.proc = null;
    record.state.pid = undefined;
    for (const [, p] of record.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`Extension "${extensionId}" was stopped`));
    }
    record.pending.clear();
    try {
      proc.kill("SIGKILL");
    } catch {}
  }

  getExtensionState(extensionId: string): ExtensionRuntimeState | undefined {
    const record = this.extensions.get(extensionId);
    return record ? this.cloneState(record.state) : undefined;
  }

  listExtensions(): ExtensionRuntimeState[] {
    return [...this.extensions.values()].map((r) => this.cloneState(r.state));
  }

  getExtensionLogs(extensionId: string): ExtensionLogEntry[] {
    const record = this.extensions.get(extensionId);
    return record ? [...record.state.logs] : [];
  }

  /**
   * Produces TERMINUS ToolDefinitions for all tools contributed by enabled extensions.
   * Enforces PermissionEngine and attributes every call to `extension:<id>`.
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
    const result: ToolDefinition<never>[] = [];

    for (const [extId, record] of this.extensions.entries()) {
      const { state } = record;
      if (!state.enabled || state.status === "disabled") continue;

      for (const toolMeta of state.registeredTools) {
        const qualifiedName = `ext__${extId}__${toolMeta.name}`;
        const tier = toolMeta.tier;

        const def: ToolDefinition<Record<string, unknown>> = {
          name: qualifiedName,
          description: `[Plugin:${state.manifest.name}] ${toolMeta.description}`,
          tier,
          schema: z.record(z.string(), z.unknown()),
          execute: async (input) => {
            const origin = `extension:${extId}`;

            // Enforce mode restrictions
            if (
              (options.mode === "plan" || options.mode === "ask" || options.mode === "audit") &&
              tier !== "read"
            ) {
              const reason = `mode "${options.mode}" forbids non-read extension tool "${qualifiedName}"`;
              options.onPermissionEvaluated?.({
                origin,
                actionKind: "extension_tool",
                target: qualifiedName,
                tier,
                verdict: "deny",
                reason,
              });
              return { ok: false, output: `blocked by policy: ${reason}`, truncated: false };
            }

            // Inspect string parameters against hard-deny rules
            const check = engine.evaluate({
              kind: "command",
              command: `echo ${JSON.stringify(input)}`,
            });
            if (check.action === "deny" && check.reason.includes("hard-deny")) {
              options.onPermissionEvaluated?.({
                origin,
                actionKind: "extension_tool",
                target: qualifiedName,
                tier,
                verdict: "deny",
                reason: check.reason,
              });
              return { ok: false, output: `blocked by policy: ${check.reason}`, truncated: false };
            }

            if (tier === "high_impact" || (options.mode === "act" && tier === "modify")) {
              if (options.approver) {
                const outcome = await options.approver({
                  summary: `Extension Tool ${qualifiedName}`,
                  detail: JSON.stringify(input, null, 2),
                  tier,
                });
                options.onPermissionEvaluated?.({
                  origin,
                  actionKind: "extension_tool",
                  target: qualifiedName,
                  tier,
                  verdict: outcome.approved ? "approved" : "rejected",
                  reason: outcome.feedback ?? "user approval gate",
                });
                if (!outcome.approved) {
                  return {
                    ok: false,
                    output: "the user rejected this extension tool invocation",
                    truncated: false,
                  };
                }
              }
            } else {
              options.onPermissionEvaluated?.({
                origin,
                actionKind: "extension_tool",
                target: qualifiedName,
                tier,
                verdict: "allow",
                reason: "permitted extension tool",
              });
            }

            const res = await this.invokeExtensionTool(
              extId,
              toolMeta.name,
              input,
              options.workspaceRoot,
            );
            return {
              ok: res.ok,
              output: res.output,
              truncated: false,
            };
          },
        };

        result.push(def as unknown as ToolDefinition<never>);
      }
    }

    return result;
  }

  /**
   * Scaffolds a ready-to-develop TERMINUS extension directory using `@terminus/extension-sdk`.
   */
  scaffoldExtensionTemplate(
    targetRootDir: string,
    options: {
      id: string;
      name: string;
      description: string;
    },
  ): { directory: string; manifest: ExtensionManifest } {
    const extDir = join(targetRootDir, options.id);
    mkdirSync(join(extDir, "src"), { recursive: true });

    const manifest: ExtensionManifest = {
      id: options.id,
      name: options.name,
      version: "0.1.0",
      description: options.description,
      engineVersion: ">=0.3.0",
      entrypoint: "src/index.ts",
      capabilities: ["tools", "slash_commands"],
      permissions: ["fs:read"],
      allowedHosts: [],
      timeoutMs: 10_000,
      memoryLimitMb: 128,
    };

    writeFileSync(
      join(extDir, "terminus-extension.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );

    writeFileSync(
      join(extDir, "src", "index.ts"),
      `import { defineExtension } from "@terminus/extension-sdk";

export default defineExtension((ctx) => {
  ctx.logger.info("Initialized ${options.name}");

  ctx.registerTool({
    name: "inspect_status",
    description: "Runs a custom read-only diagnostic check for ${options.name}",
    tier: "read",
    execute: async (_input, toolCtx) => {
      return {
        ok: true,
        output: \`[${options.id}] Verified workspace at \${toolCtx.workspaceRoot}\`,
      };
    },
  });

  ctx.registerSlashCommand({
    command: "/${options.id}",
    description: "Trigger ${options.name} workflow",
    expandPrompt: (args) => \`Execute ${options.name} workflow with arguments: \${args}\`,
  });
});
`,
      "utf8",
    );

    return { directory: extDir, manifest };
  }

  async shutdownAll(): Promise<void> {
    await Promise.allSettled(
      [...this.extensions.keys()].map((extId) => this.terminateWorker(extId)),
    );
  }
}
