#!/usr/bin/env bun
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  createAgent,
  HarnessRouter,
  isTaskLike,
  MasterOrchestrator,
  scanFiles,
  verifyEditedFile,
} from "@terminus/agent-runtime";
import { analyzeProject } from "@terminus/context-engine";
import { BudgetTracker, type ProviderName, selectGateway } from "@terminus/model-gateway";
import { startGuiHttpServer, TerminusRuntimeBridge } from "@terminus/runtime-bridge";
import { SessionStore } from "@terminus/session-store";
import type {
  AgentEvent,
  ApprovalOutcome,
  ApprovalRequest,
  CompletionReport,
  Mode,
} from "@terminus/shared";
import { renderWorkspaceHtml } from "@terminus/workspace-ui";
import { loadConfig } from "./config";
import {
  approvalCard,
  chatHint,
  elapsed,
  emptyDash,
  header,
  pace,
  planCard,
  recordState,
  recordTool,
  reportCard,
  resultLine,
  SHORT,
  spin,
  stateLine,
  stone,
  timeline,
  toolLine,
  usageLine,
} from "./dashboard";
import { scanShortcuts } from "./debt";
import { loadHomeEnv } from "./env";
import { clip, fitWidth, wrap } from "./fit";
import { interactiveSelect } from "./menu";
import { replaySession } from "./replay";
import { buildPriorContext } from "./resume";
import { createStatus } from "./status";
import { firstRun, setUiOutput, uiWrite } from "./ui";
import { VERSION } from "./version";

interface CliArgs {
  task: string;
  dir: string;
  mode?: Mode;
  yes: boolean;
  model?: string;
  provider?: ProviderName;
  verify: string[];
  help: boolean;
  report?: "json";
  resumeId?: string;
  replayId?: string;
  listSessions: boolean;
  showDebt: boolean;
  doctor: boolean;
  harnesses: boolean;
  orchestrate: boolean;
  gui: boolean;
  guiPort?: number;
  skills: boolean;
  approveSkill?: string;
  mcp: boolean;
  testMcp?: string;
  extensions: boolean;
  timeoutSeconds?: number;
  maxIterations?: number;
  maxTokens?: number;
  maxCostUsd?: number;
  version: boolean;
}

const MODES: Mode[] = ["ask", "plan", "audit", "act", "auto"];
const PROVIDERS: ProviderName[] = ["nebius", "anthropic", "openai", "gemini", "ollama"];

const runDoctor = (workspaceRoot: string, store: SessionStore): void => {
  const checks: { name: string; ok: boolean; detail: string }[] = [];
  checks.push({
    name: "runtime",
    ok: true,
    detail: `Bun ${typeof Bun !== "undefined" ? Bun.version : process.version} (${process.platform}/${process.arch})`,
  });
  let gitOk = false;
  let gitDetail = "not available";
  try {
    gitDetail = execSync("git --version", { cwd: workspaceRoot, encoding: "utf8" }).trim();
    gitOk = true;
  } catch {
    gitOk = false;
  }
  checks.push({ name: "git", ok: gitOk, detail: gitDetail });
  const hasKey = Boolean(
    process.env.NEBIUS_API_KEY ||
      process.env.ANTHROPIC_API_KEY ||
      process.env.OPENAI_API_KEY ||
      process.env.GEMINI_API_KEY,
  );
  const configuredKeys = [
    process.env.NEBIUS_API_KEY ? "NEBIUS_API_KEY" : null,
    process.env.ANTHROPIC_API_KEY ? "ANTHROPIC_API_KEY" : null,
    process.env.OPENAI_API_KEY ? "OPENAI_API_KEY" : null,
    process.env.GEMINI_API_KEY ? "GEMINI_API_KEY" : null,
    process.env.TAVILY_API_KEY ? "TAVILY_API_KEY" : null,
  ].filter(Boolean);
  checks.push({
    name: "credentials",
    ok: hasKey,
    detail: hasKey ? `configured (${configuredKeys.join(", ")})` : "no provider API key set",
  });
  try {
    const count = store.recentSessions(workspaceRoot, 5).length;
    checks.push({
      name: "session-store",
      ok: true,
      detail: `SQLite healthy (${count} recent session(s))`,
    });
  } catch (err) {
    checks.push({
      name: "session-store",
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  }
  const intel = analyzeProject(workspaceRoot);
  checks.push({
    name: "workspace",
    ok: existsSync(workspaceRoot),
    detail: `${workspaceRoot} (${intel.languages.join(", ") || "no code detected"}${intel.frameworks.length > 0 ? ` · ${intel.frameworks.join(", ")}` : ""})`,
  });
  process.stdout.write("  terminus doctor\n");
  for (const c of checks) {
    process.stdout.write(`    ${c.ok ? "✓" : "✗"} ${c.name.padEnd(15)} ${c.detail}\n`);
  }
};

const parseArgs = (argv: string[]): CliArgs => {
  const args: CliArgs = {
    task: "",
    dir: ".",
    yes: false,
    verify: [],
    help: false,
    listSessions: false,
    showDebt: false,
    doctor: false,
    harnesses: false,
    orchestrate: false,
    gui: false,
    skills: false,
    mcp: false,
    extensions: false,
    version: false,
  };
  const words: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    switch (arg) {
      case "--help":
      case "-h":
        args.help = true;
        break;
      case "--yes":
      case "-y":
        args.yes = true;
        break;
      case "--sessions":
        args.listSessions = true;
        break;
      case "--debt":
        args.showDebt = true;
        break;
      case "--doctor":
        args.doctor = true;
        break;
      case "--harnesses":
        args.harnesses = true;
        break;
      case "--skills":
        args.skills = true;
        break;
      case "--approve-skill": {
        const s = argv[++i];
        if (!s || s.startsWith("--")) {
          console.error("--approve-skill expects a skill name");
          process.exit(2);
        }
        args.approveSkill = s;
        break;
      }
      case "--mcp":
        args.mcp = true;
        break;
      case "--test-mcp": {
        const m = argv[++i];
        if (!m || m.startsWith("--")) {
          console.error("--test-mcp expects an MCP preset/server name");
          process.exit(2);
        }
        args.testMcp = m;
        break;
      }
      case "--extensions":
      case "--plugins":
        args.extensions = true;
        break;
      case "--orchestrate":
        args.orchestrate = true;
        break;
      case "--gui":
        args.gui = true;
        break;
      case "--port": {
        const p = Number(argv[++i]);
        if (!Number.isFinite(p) || p <= 0) {
          console.error("--port expects a valid TCP port number");
          process.exit(2);
        }
        args.guiPort = p;
        break;
      }
      case "--version":
      case "-v":
        args.version = true;
        break;
      case "--dir":
        args.dir = argv[++i] ?? ".";
        break;
      case "--mode": {
        const mode = argv[++i] as Mode;
        if (MODES.includes(mode)) args.mode = mode;
        else {
          console.error(`unknown mode: ${mode} (expected ${MODES.join(" | ")})`);
          process.exit(2);
        }
        break;
      }
      case "--model":
        args.model = argv[++i];
        break;
      case "--provider": {
        const provider = argv[++i] as ProviderName;
        if (PROVIDERS.includes(provider)) args.provider = provider;
        else {
          console.error(`unknown provider: ${provider} (expected ${PROVIDERS.join(" | ")})`);
          process.exit(2);
        }
        break;
      }
      case "--report": {
        const report = argv[++i];
        if (report === "json") args.report = "json";
        else {
          console.error(`unknown report format: ${report} (expected json)`);
          process.exit(2);
        }
        break;
      }
      case "--resume": {
        const id = argv[++i];
        if (!id || id.startsWith("--")) {
          console.error("--resume expects a session id (see --sessions)");
          process.exit(2);
        }
        args.resumeId = id;
        break;
      }
      case "--replay": {
        const id = argv[++i];
        if (!id || id.startsWith("--")) {
          console.error("--replay expects a session id (see --sessions)");
          process.exit(2);
        }
        args.replayId = id;
        break;
      }
      case "--timeout": {
        const seconds = Number(argv[++i]);
        if (!Number.isFinite(seconds) || seconds <= 0) {
          console.error("--timeout expects a positive number of seconds");
          process.exit(2);
        }
        args.timeoutSeconds = seconds;
        break;
      }
      case "--max-iterations":
      case "--iterations": {
        const count = Number(argv[++i]);
        if (!Number.isFinite(count) || count <= 0) {
          console.error("--max-iterations expects a positive integer");
          process.exit(2);
        }
        args.maxIterations = count;
        break;
      }
      case "--max-tokens": {
        const tokens = Number(argv[++i]);
        if (!Number.isFinite(tokens) || tokens <= 0) {
          console.error("--max-tokens expects a positive integer");
          process.exit(2);
        }
        args.maxTokens = tokens;
        break;
      }
      case "--max-cost": {
        const cost = Number(argv[++i]);
        if (!Number.isFinite(cost) || cost <= 0) {
          console.error("--max-cost expects a positive USD amount");
          process.exit(2);
        }
        args.maxCostUsd = cost;
        break;
      }
      case "--verify":
        args.verify.push(...(argv[++i] ?? "").split(",").filter(Boolean));
        break;
      default:
        if (arg.startsWith("--")) {
          console.error(`unknown flag: ${arg} (see --help)`);
          process.exit(2);
        }
        words.push(arg);
    }
  }
  args.task = words.join(" ").trim();
  return args;
};

const exitCodeFor = (report: CompletionReport): number =>
  report.outcome === "completed" ? 0 : report.outcome === "cancelled" ? 2 : 1;

const main = async (): Promise<number> => {
  const args = parseArgs(process.argv.slice(2));
  loadHomeEnv();
  if (args.version) {
    process.stdout.write(`terminus ${VERSION}\n`);
    process.stdout.write(`  ┌──      ──┐  TERMINUS v${VERSION}\n`);
    process.stdout.write(`  │   ████   │  Autonomous AI Software Engineering Workspace\n`);
    process.stdout.write(
      `  │    ██    │  Runtime: Bun/Node (${process.platform}/${process.arch})\n`,
    );
    process.stdout.write(
      `  │    ██  ■ │  Evidence Ledger · Skills Studio · MCP Client · Plugin Host\n`,
    );
    process.stdout.write(`  └──      ──┘\n`);
    return 0;
  }
  const repl = args.help
    ? false
    : args.task.length === 0 &&
      !args.listSessions &&
      !args.showDebt &&
      !args.doctor &&
      !args.harnesses &&
      !args.skills &&
      !args.approveSkill &&
      !args.mcp &&
      !args.testMcp &&
      !args.extensions &&
      !args.gui &&
      !args.replayId &&
      process.stdin.isTTY;
  if (
    args.help ||
    (args.task.length === 0 &&
      !args.listSessions &&
      !args.showDebt &&
      !args.doctor &&
      !args.harnesses &&
      !args.skills &&
      !args.approveSkill &&
      !args.mcp &&
      !args.testMcp &&
      !args.extensions &&
      !args.gui &&
      !args.replayId &&
      !repl)
  ) {
    process.stdout.write(firstRun());
    return args.help ? 0 : 2;
  }

  const workspaceRoot = resolve(args.dir);
  if (!existsSync(workspaceRoot)) {
    console.error(`directory not found: ${workspaceRoot}`);
    return 2;
  }

  const config = loadConfig(workspaceRoot);
  const mode =
    [args.mode, config.mode].find(
      (value): value is Mode => value !== undefined && MODES.includes(value),
    ) ?? "act";
  const verify = args.verify.length > 0 ? args.verify : config.verify;
  const timeoutSeconds = args.timeoutSeconds ?? config.timeoutSeconds;
  const maxTokens = args.maxTokens ?? config.maxTokens;
  const maxCostUsd = args.maxCostUsd ?? config.maxCostUsd;
  const jsonMode = args.report === "json";
  if (jsonMode) setUiOutput(process.stderr);

  if (args.showDebt) {
    const shortcuts = scanShortcuts(workspaceRoot);
    if (shortcuts.length === 0) {
      process.stdout.write("  no shortcut: comments found\n");
    } else {
      process.stdout.write(`  ${shortcuts.length} shortcut(s) on record\n`);
      for (const item of shortcuts) {
        process.stdout.write(`    ${item.file}:${item.line}  ${item.text}\n`);
      }
    }
    return 0;
  }

  const store = new SessionStore();

  if (args.doctor) {
    runDoctor(workspaceRoot, store);
    store.close();
    return 0;
  }

  if (args.gui) {
    const bridge = new TerminusRuntimeBridge({ workspaceRoot, store });
    const handle = await startGuiHttpServer({
      bridge,
      renderHtml: (bootstrap) => renderWorkspaceHtml(bootstrap, { hostMode: "browser" }),
      port: args.guiPort ?? 4190,
    });
    process.stdout.write(`  TERMINUS Developer Workspace running at ${handle.url}\n`);
    process.stdout.write(`  Workspace root: ${workspaceRoot}\n`);
    await new Promise<void>((resolveStop) => {
      process.once("SIGINT", () => resolveStop());
      process.once("SIGTERM", () => resolveStop());
    });
    await handle.close();
    await bridge.shutdown();
    store.close();
    return 0;
  }

  if (args.harnesses) {
    const router = new HarnessRouter();
    process.stdout.write("  registered OO-Harness profiles\n");
    for (const h of router.listHarnesses()) {
      process.stdout.write(
        `    ${h.name.padEnd(28)} role:${h.role.padEnd(20)} fs:${h.permissions.filesystem.padEnd(15)} parent:${h.parentName ?? "root"}\n`,
      );
    }
    store.close();
    return 0;
  }

  if (args.skills || args.approveSkill) {
    const bridge = new TerminusRuntimeBridge({ workspaceRoot, store });
    if (args.approveSkill) {
      const skills = bridge.listSkills(workspaceRoot);
      const target = skills.find((s) => s.name === args.approveSkill);
      if (!target) {
        console.error(`Skill "${args.approveSkill}" not found in workspace or library.`);
        await bridge.shutdown();
        store.close();
        return 2;
      }
      const res = bridge.approveQuarantinedSkill(target.name, target.content);
      process.stdout.write(`  ✓ Skill "${target.name}" approved.\n`);
      process.stdout.write(`    SHA-256: ${res.sha256}\n`);
      process.stdout.write(`    Trust State: trusted\n`);
      await bridge.shutdown();
      store.close();
      return 0;
    }
    const skills = bridge.listSkills(workspaceRoot);
    if (skills.length === 0) {
      process.stdout.write("  TERMINUS Skills Studio\n");
      process.stdout.write("    no skills found in workspace or user library\n");
    } else if (process.stdin.isTTY) {
      const selected = await interactiveSelect(
        "TERMINUS Skills Studio — Select a skill to inspect or approve",
        skills.map((s) => ({
          label: s.name,
          value: s,
          badge: s.trustState === "quarantined" ? "quarantined" : s.scope || "workspace",
          hint: clip(s.description || "", 40),
        })),
      );
      if (selected) {
        process.stdout.write(
          `\n  \x1B[1m${selected.name}\x1B[0m (${selected.scope || "workspace"})\n`,
        );
        process.stdout.write(`  Trust state: ${selected.trustState || "trusted"}\n`);
        process.stdout.write(`  Description: ${selected.description || "none"}\n`);
        if (selected.trustState === "quarantined") {
          const res = bridge.approveQuarantinedSkill(selected.name, selected.content);
          process.stdout.write(`  ✓ Skill "${selected.name}" approved.\n`);
          process.stdout.write(`    SHA-256: ${res.sha256}\n`);
        }
      }
    } else {
      process.stdout.write("  TERMINUS Skills Studio\n");
      for (const s of skills) {
        const trust = s.trustState === "quarantined" ? "[quarantined]" : "[trusted]    ";
        process.stdout.write(
          `    ${trust}  ${(s.scope || "workspace").padEnd(10)}  ${s.name.padEnd(24)}  ${clip(s.description || "", 45)}\n`,
        );
      }
    }
    await bridge.shutdown();
    store.close();
    return 0;
  }

  if (args.mcp || args.testMcp) {
    const bridge = new TerminusRuntimeBridge({ workspaceRoot, store });
    if (args.testMcp) {
      process.stdout.write(`  Testing MCP connection for "${args.testMcp}"...\n`);
      try {
        const start = Date.now();
        const res = await bridge.connectMcpServer(args.testMcp);
        const latencyMs = Date.now() - start;
        if (res.status === "connected") {
          process.stdout.write(`  ✓ Connected to "${args.testMcp}" (Latency: ${latencyMs}ms)\n`);
          process.stdout.write(`    Discovered Tools (${res.tools.length}):\n`);
          for (const t of res.tools) {
            process.stdout.write(`      - ${t.name}: ${clip(t.description || "", 50)}\n`);
          }
        } else {
          process.stdout.write(
            `  ✗ Connection status: ${res.status} (${res.lastError || "unknown"})\n`,
          );
        }
        await bridge.shutdown();
        store.close();
        return res.status === "connected" ? 0 : 1;
      } catch (err) {
        process.stdout.write(
          `  ✗ Connection failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        await bridge.shutdown();
        store.close();
        return 1;
      }
    }
    const mcpData = bridge.listMcpServers();
    if (process.stdin.isTTY && mcpData.presets.length > 0) {
      const selectedPreset = await interactiveSelect(
        "TERMINUS MCP Servers — Select a preset to test connection and inspect tools",
        mcpData.presets.map((p) => ({
          label: p.name,
          value: p,
          badge: p.template.transport,
          hint: clip(p.description, 40),
        })),
      );
      if (selectedPreset) {
        process.stdout.write(
          `\n  Connecting to ${selectedPreset.name} (${selectedPreset.template.transport})...\n`,
        );
        const start = Date.now();
        const res = await bridge.connectMcpServer(selectedPreset.name);
        const latencyMs = Date.now() - start;
        if (res.status === "connected") {
          process.stdout.write(`  ✓ Connected (Latency: ${latencyMs}ms)\n`);
          process.stdout.write(`  Discovered Tools (${res.tools.length}):\n`);
          for (const t of res.tools) {
            process.stdout.write(`    - ${t.name}: ${clip(t.description || "", 50)}\n`);
          }
        } else {
          process.stdout.write(`  ✗ Status: ${res.status} (${res.lastError || "failed"})\n`);
        }
      }
    } else {
      process.stdout.write("  TERMINUS MCP & Integrations\n");
      process.stdout.write("  Presets & Active Connections:\n");
      for (const p of mcpData.presets) {
        process.stdout.write(
          `    ${p.name.padEnd(16)} transport:${p.template.transport.padEnd(14)} ${clip(p.description, 45)}\n`,
        );
      }
    }
    await bridge.shutdown();
    store.close();
    return 0;
  }

  if (args.extensions) {
    const bridge = new TerminusRuntimeBridge({ workspaceRoot, store });
    const exts = bridge.listExtensions();
    process.stdout.write("  TERMINUS Isolated Plugin Extension Host\n");
    if (exts.length === 0) {
      process.stdout.write("    0 extensions installed. Add plugins in ~/.terminus/plugins\n");
    } else if (process.stdin.isTTY) {
      const selected = await interactiveSelect(
        "TERMINUS Plugins — Select an extension to inspect",
        exts.map((e) => ({
          label: e.manifest.name,
          value: e,
          badge: e.status,
          hint: clip(e.manifest.description || "", 40),
        })),
      );
      if (selected) {
        process.stdout.write(
          `\n  \x1B[1m${selected.manifest.name}\x1B[0m (v${selected.manifest.version})\n`,
        );
        process.stdout.write(`  Status: ${selected.status}\n`);
        process.stdout.write(`  Description: ${selected.manifest.description || "none"}\n`);
      }
    } else {
      for (const ext of exts) {
        process.stdout.write(
          `    ${ext.manifest.name.padEnd(20)} status:${ext.status.padEnd(12)} ${clip(ext.manifest.description || "", 45)}\n`,
        );
      }
    }
    await bridge.shutdown();
    store.close();
    return 0;
  }

  if (args.listSessions) {
    const sessions = store.recentSessions(workspaceRoot, 10);
    if (sessions.length === 0) {
      process.stdout.write("  no sessions for this workspace yet\n");
    } else {
      process.stdout.write("  recent sessions\n");
      for (const session of sessions) {
        const when = new Date(session.created_at).toISOString().slice(0, 16).replace("T", " ");
        const room = Math.max(16, fitWidth() - 54);
        process.stdout.write(
          `    ${session.id.slice(0, 8)}  ${session.state.padEnd(18)} ${when}  ${clip(session.task, room)}\n`,
        );
      }
    }
    store.close();
    return 0;
  }

  if (args.replayId) {
    const ok = replaySession(store, args.replayId);
    store.close();
    return ok ? 0 : 2;
  }

  const selectedProvider = args.provider ?? config.provider;
  const hasAnyKey =
    selectedProvider === "ollama" ||
    Boolean(
      process.env.NEBIUS_API_KEY ||
        process.env.ANTHROPIC_API_KEY ||
        process.env.OPENAI_API_KEY ||
        process.env.GEMINI_API_KEY,
    );
  if (!hasAnyKey) {
    process.stdout.write(firstRun());
    console.error(
      "No provider API key is set. Export NEBIUS_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY (or use --provider ollama).",
    );
    store.close();
    return 2;
  }

  const { gateway, label } = selectGateway({
    provider: selectedProvider,
    model: args.model ?? config.model,
  });
  const budget = new BudgetTracker({
    maxTokens,
    maxCostUsd,
    model: args.model ?? config.model ?? label,
  });

  if (!jsonMode) process.stdout.write(`${header(workspaceRoot, mode, label)}\n\n`);

  const readline = createInterface({ input: process.stdin, output: process.stderr });
  let dash = emptyDash();
  let pendingText = false;
  const status = createStatus(
    jsonMode ? { write: () => undefined } : process.stdout,
    () => `  ${spin(dash)} ${stone(SHORT[dash.current ?? "queued"])} · ${stone(pace(dash))}`,
  );
  const autoApprove = args.yes || mode === "auto";
  const sessionAlways = new Set<string>();
  const approver = async (request: ApprovalRequest): Promise<ApprovalOutcome> => {
    status.stop();
    if (sessionAlways.has(request.summary)) return { approved: true };
    if (autoApprove && request.tier !== "high_impact") {
      process.stderr.write(`  · auto-approved: ${request.summary}\n`);
      return { approved: true };
    }
    if (request.summary === "Approve plan" && request.detail) {
      uiWrite(`${planCard(request.detail)}\n`);
      const answer = (await readline.question("  approve plan? [y]es / [n]o / [f]eedback: "))
        .trim()
        .toLowerCase();
      if (answer.startsWith("y")) return { approved: true };
      if (answer.startsWith("f")) {
        const feedback = (await readline.question("  feedback: ")).trim();
        return { approved: false, feedback };
      }
      return { approved: false };
    }
    uiWrite(`${approvalCard(request.summary)}\n`);
    const answer = (await readline.question("  › ")).trim().toLowerCase();
    if (answer === "a" || answer === "always") {
      sessionAlways.add(request.summary);
      return { approved: true };
    }
    return { approved: answer === "y" || answer === "yes" };
  };

  const onEvent = (event: AgentEvent): void => {
    status.note();
    if (event.type !== "text" && pendingText) {
      uiWrite("\n");
      pendingText = false;
    }
    switch (event.type) {
      case "state":
        recordState(dash, event.to);
        uiWrite(`${stateLine(event.to)}\n`);
        break;
      case "text":
        uiWrite(event.text);
        pendingText = true;
        break;
      case "plan":
        break;
      case "tool":
        recordTool(dash);
        uiWrite(`${toolLine(event.name, event.input, event.decision)}\n`);
        break;
      case "tool_result": {
        const line = resultLine(event.name, event.ok, event.summary);
        if (line) uiWrite(`${line}\n`);
        break;
      }
      case "usage":
        budget.record(event.prompt, event.completion);
        uiWrite(`${usageLine(event.prompt, event.completion)}\n`);
        break;
      case "report":
        uiWrite(`${timeline(dash)}\n${elapsed(dash)}\n${reportCard(event.report)}\n`);
        break;
      case "approval":
        break;
    }
    if (
      event.type === "state" ||
      event.type === "tool" ||
      event.type === "tool_result" ||
      event.type === "usage"
    ) {
      status.arm();
    }
  };

  let priorContext: string | undefined;
  if (args.resumeId) {
    const resumed = buildPriorContext(store, args.resumeId);
    if (resumed.error) {
      console.error(resumed.error);
      store.close();
      return 2;
    }
    priorContext = resumed.context;
  }

  const agent = createAgent({
    workspaceRoot,
    gateway,
    approver,
    emit: jsonMode ? () => {} : onEvent,
    mode,
    store,
    verifyCommands: verify,
    maxIterations: args.maxIterations,
    maxTokens,
    commandTimeoutMs: timeoutSeconds !== undefined ? timeoutSeconds * 1000 : undefined,
    priorContext,
  });

  let active: AbortController | null = null;
  process.on("SIGINT", () => {
    status.stop();
    if (active && !active.signal.aborted) {
      active.abort();
      return;
    }
    readline.close();
    process.exit(130);
  });

  const runOne = async (task: string): Promise<CompletionReport> => {
    dash = emptyDash();
    const controller = new AbortController();
    active = controller;
    try {
      return await agent.run(task, { signal: controller.signal });
    } finally {
      status.stop();
      if (pendingText) {
        uiWrite("\n");
        pendingText = false;
      }
      active = null;
    }
  };

  const chatOne = async (message: string): Promise<void> => {
    const controller = new AbortController();
    active = controller;
    try {
      await agent.chat(message, { signal: controller.signal });
    } finally {
      status.stop();
      if (pendingText) {
        uiWrite("\n");
        pendingText = false;
      }
      active = null;
    }
  };

  try {
    if (!repl) {
      if (args.orchestrate) {
        const orchestrator = new MasterOrchestrator();
        const res = await orchestrator.orchestrate(args.task, {
          workspaceRoot,
          gateway,
          approver,
          runAdversarialPass: true,
        });
        process.stdout.write(`\n${res.verdictReport.summary}\n`);
        return res.verdictReport.overallVerdict === "VERIFIED" ? 0 : 1;
      }
      const report = await runOne(args.task);
      if (jsonMode) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return exitCodeFor(report);
    }

    const hint = wrap(chatHint, fitWidth() - 2)
      .map((row) => `  ${row}`)
      .join("\n");
    process.stdout.write(`\n${hint}\n`);
    let awaiting = false;
    const onResize = (): void => {
      if (!awaiting) return;
      const typed = (readline as unknown as { line?: string }).line ?? "";
      process.stderr.write(`\r\x1b[2Kterminus › ${typed}`);
    };
    process.stdout.on("resize", onResize);
    while (true) {
      let line = "";
      try {
        awaiting = true;
        line = (await readline.question("\nterminus › ")).trim();
      } catch {
        break;
      } finally {
        awaiting = false;
      }
      if (line.length === 0) continue;
      if (line === "/quit" || line === "/exit") break;
      if (line === "/clear") {
        agent.reset();
        budget.reset();
        process.stdout.write("  session context cleared\n");
        continue;
      }
      if (line === "/help") {
        process.stdout.write(
          `${[
            "  /status       workspace intelligence, git branch, model & token usage",
            "  /skills       list discovered skills in workspace & global library",
            "  /mcp          list registered MCP servers & tool catalog",
            "  /extensions   list installed isolated plugin extensions",
            "  /models       list supported model providers & API credentials",
            "  /harnesses    list registered OO-Harness profiles & permission boundaries",
            "  /route <task> preview task+trajectory harness routing decision",
            "  /orchestrate  run verified multi-agent harness orchestrator (/orchestrate <task>)",
            "  /plan         show the latest implementation plan",
            "  /diff         show current git diff stat",
            "  /undo         rollback all file edits from this session",
            "  /review       run static security & import/export verifier on modified files",
            "  /usage        show session token & estimated cost breakdown",
            "  /budget       view or set session token budget (/budget <tokens>)",
            "  /compact      compress conversation history to save context window",
            "  /doctor       run environment & workspace health diagnostics",
            "  /sessions     list recent sessions",
            "  /debt         shortcut: ledger",
            "  /clear        forget conversation context",
            "  /quit         exit",
          ].join("\n")}\n`,
        );
        continue;
      }
      if (line === "/skills") {
        const bridge = new TerminusRuntimeBridge({ workspaceRoot, store });
        const skills = bridge.listSkills(workspaceRoot);
        process.stdout.write("  TERMINUS Skills Studio\n");
        if (skills.length === 0) {
          process.stdout.write("    no skills found in workspace or user library\n");
        } else {
          for (const s of skills) {
            const trust = s.trustState === "quarantined" ? "[quarantined]" : "[trusted]    ";
            process.stdout.write(
              `    ${trust}  ${(s.scope || "workspace").padEnd(10)}  ${s.name.padEnd(24)}  ${clip(s.description || "", 45)}\n`,
            );
          }
        }
        await bridge.shutdown();
        continue;
      }
      if (line === "/mcp") {
        const bridge = new TerminusRuntimeBridge({ workspaceRoot, store });
        const mcpData = bridge.listMcpServers();
        process.stdout.write("  TERMINUS MCP & Integrations\n");
        for (const p of mcpData.presets) {
          process.stdout.write(
            `    ${p.name.padEnd(16)} transport:${p.template.transport.padEnd(14)} ${clip(p.description, 45)}\n`,
          );
        }
        await bridge.shutdown();
        continue;
      }
      if (line === "/extensions") {
        const bridge = new TerminusRuntimeBridge({ workspaceRoot, store });
        const exts = bridge.listExtensions();
        process.stdout.write("  TERMINUS Isolated Plugin Extension Host\n");
        if (exts.length === 0) {
          process.stdout.write("    0 extensions installed. Add plugins in ~/.terminus/plugins\n");
        } else {
          for (const ext of exts) {
            process.stdout.write(
              `    ${ext.manifest.name.padEnd(20)} status:${ext.status.padEnd(12)} ${clip(ext.manifest.description || "", 45)}\n`,
            );
          }
        }
        await bridge.shutdown();
        continue;
      }
      if (line === "/models") {
        const bridge = new TerminusRuntimeBridge({ workspaceRoot, store });
        const providers = bridge.listProviders();
        process.stdout.write("  TERMINUS Model Providers & Gateway\n");
        for (const prov of providers) {
          const keyStatus = prov.hasApiKeyConfigured ? "[key: configured]" : "[key: missing]   ";
          process.stdout.write(
            `    ${keyStatus}  ${prov.displayName.padEnd(24)} default:${prov.defaultModel}\n`,
          );
        }
        await bridge.shutdown();
        continue;
      }
      if (line === "/harnesses") {
        const router = new HarnessRouter();
        for (const h of router.listHarnesses()) {
          process.stdout.write(
            `  ${h.name.padEnd(28)} role:${h.role.padEnd(20)} fs:${h.permissions.filesystem.padEnd(15)} parent:${h.parentName ?? "root"}\n`,
          );
        }
        continue;
      }
      if (line.startsWith("/route ")) {
        const sampleTask = line.slice("/route ".length).trim();
        const router = new HarnessRouter();
        const decision = router.route(sampleTask, analyzeProject(workspaceRoot));
        process.stdout.write(
          `  strategy:  ${decision.strategy}\n  harnesses: ${decision.selectedHarnesses.map((h) => h.name).join(", ")}\n  rationale: ${decision.rationale}\n`,
        );
        continue;
      }
      if (line.startsWith("/orchestrate ")) {
        const subTask = line.slice("/orchestrate ".length).trim();
        if (subTask) {
          const orchestrator = new MasterOrchestrator();
          const res = await orchestrator.orchestrate(subTask, {
            workspaceRoot,
            gateway,
            approver,
            runAdversarialPass: true,
          });
          process.stdout.write(`\n${res.verdictReport.summary}\n`);
        }
        continue;
      }
      if (line === "/status") {
        const intel = analyzeProject(workspaceRoot);
        const snap = budget.snapshot();
        process.stdout.write(
          `${[
            `  workspace   ${workspaceRoot}`,
            `  branch      ${intel.gitBranch ?? "none"}`,
            `  mode/model  ${mode} · ${label}`,
            `  stack       ${[...intel.languages, ...intel.frameworks].join(", ") || "unknown"}`,
            `  tooling     pm:${intel.packageManager ?? "n/a"} · test:${intel.testFramework ?? "n/a"} · build:${intel.buildSystem ?? "n/a"}`,
            `  usage       ${snap.totalTokens.toLocaleString()} tokens ($${snap.estimatedCostUsd.toFixed(4)} est. across ${snap.calls} call(s))`,
          ].join("\n")}\n`,
        );
        continue;
      }
      if (line === "/plan") {
        const planText = agent.lastPlan?.();
        if (!planText) {
          process.stdout.write("  no plan recorded in this session yet\n");
        } else {
          process.stdout.write(`${planCard(planText)}\n`);
        }
        continue;
      }
      if (line === "/diff") {
        try {
          const stat = execSync("git status --short && git diff --stat", {
            cwd: workspaceRoot,
            encoding: "utf8",
          }).trim();
          process.stdout.write(stat ? `${stat}\n` : "  working tree clean\n");
        } catch {
          process.stdout.write("  not a git repository or git unavailable\n");
        }
        continue;
      }
      if (line === "/undo") {
        if (!agent.undo) {
          process.stdout.write("  undo not available\n");
          continue;
        }
        const outcome = agent.undo();
        if (outcome.restored.length === 0 && outcome.removed.length === 0) {
          process.stdout.write("  nothing to undo in this session\n");
        } else {
          if (outcome.restored.length > 0) {
            process.stdout.write(`  restored: ${outcome.restored.join(", ")}\n`);
          }
          if (outcome.removed.length > 0) {
            process.stdout.write(`  removed newly created: ${outcome.removed.join(", ")}\n`);
          }
        }
        continue;
      }
      if (line === "/review") {
        try {
          const changedRaw = execSync("git status --porcelain", {
            cwd: workspaceRoot,
            encoding: "utf8",
          }).trim();
          const files = changedRaw
            .split("\n")
            .map((r) => r.slice(3).trim())
            .filter(Boolean);
          if (files.length === 0) {
            process.stdout.write("  no modified files in git working tree to review\n");
            continue;
          }
          const sast = scanFiles(files, workspaceRoot);
          const issues = files.flatMap((f) => verifyEditedFile(workspaceRoot, f));
          if (sast.length === 0 && issues.length === 0) {
            process.stdout.write(
              `  ✓ reviewed ${files.length} modified file(s): 0 SAST or static verification issues\n`,
            );
          } else {
            for (const issue of issues) {
              process.stdout.write(
                `  [${issue.severity}] ${issue.code} ${issue.file}${issue.line ? `:${issue.line}` : ""} — ${issue.message}\n`,
              );
            }
          }
        } catch {
          process.stdout.write("  unable to determine modified files via git\n");
        }
        continue;
      }
      if (line === "/usage" || line.startsWith("/budget")) {
        const parts = line.split(/\s+/);
        if (parts[0] === "/budget" && parts[1]) {
          const nextMax = Number(parts[1]);
          if (Number.isFinite(nextMax) && nextMax > 0) {
            budget.setLimits({ maxTokens: nextMax });
            process.stdout.write(`  token budget set to ${nextMax.toLocaleString()} tokens\n`);
          } else {
            process.stdout.write("  usage: /budget <positive_token_limit>\n");
          }
          continue;
        }
        const snap = budget.snapshot();
        process.stdout.write(
          `  prompt: ${snap.promptTokens.toLocaleString()} · completion: ${snap.completionTokens.toLocaleString()} · total: ${snap.totalTokens.toLocaleString()} tokens · calls: ${snap.calls} · est. cost: $${snap.estimatedCostUsd.toFixed(4)}${snap.maxTokens ? ` · limit: ${snap.maxTokens.toLocaleString()} tokens` : ""}\n`,
        );
        continue;
      }
      if (line === "/compact") {
        if (!agent.compact) {
          process.stdout.write("  compaction unavailable\n");
          continue;
        }
        const stats = agent.compact();
        process.stdout.write(
          `  compacted ${stats.compactedResultsCount} tool output(s), saved ~${stats.estimatedTokensSaved.toLocaleString()} tokens\n`,
        );
        continue;
      }
      if (line === "/doctor") {
        runDoctor(workspaceRoot, store);
        continue;
      }
      if (line === "/debt") {
        for (const item of scanShortcuts(workspaceRoot)) {
          process.stdout.write(`  ${item.file}:${item.line}  ${item.text}\n`);
        }
        continue;
      }
      if (line === "/sessions") {
        for (const session of store.recentSessions(workspaceRoot, 10)) {
          const room = Math.max(16, fitWidth() - 34);
          process.stdout.write(
            `  ${session.id.slice(0, 8)}  ${session.state.padEnd(18)} ${clip(session.task, room)}\n`,
          );
        }
        continue;
      }
      if (isTaskLike(line)) {
        await runOne(line);
        continue;
      }
      await chatOne(line);
    }
    process.stdout.off("resize", onResize);
    return 0;
  } finally {
    readline.close();
    store.close();
  }
};

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
