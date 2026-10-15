#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { createAgent } from "@terminus/agent-runtime";
import { selectGateway } from "@terminus/model-gateway";
import { SessionStore } from "@terminus/session-store";
import type {
  AgentEvent,
  ApprovalOutcome,
  ApprovalRequest,
  CompletionReport,
  Mode,
} from "@terminus/shared";
import { loadConfig } from "./config";
import { loadHomeEnv } from "./env";
import { buildPriorContext } from "./resume";
import {
  banner,
  firstRun,
  printPlan,
  printReport,
  printState,
  printText,
  printTool,
  printToolResult,
  printUsage,
  setUiOutput,
} from "./ui";
import { VERSION } from "./version";

interface CliArgs {
  task: string;
  dir: string;
  mode?: Mode;
  yes: boolean;
  model?: string;
  provider?: "nebius" | "anthropic";
  verify: string[];
  help: boolean;
  report?: "json";
  resumeId?: string;
  listSessions: boolean;
  timeoutSeconds?: number;
  version: boolean;
}

const MODES: Mode[] = ["ask", "plan", "act", "auto"];

const parseArgs = (argv: string[]): CliArgs => {
  const args: CliArgs = {
    task: "",
    dir: ".",
    yes: false,
    verify: [],
    help: false,
    listSessions: false,
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
        const provider = argv[++i];
        if (provider === "nebius" || provider === "anthropic") args.provider = provider;
        else {
          console.error(`unknown provider: ${provider}`);
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
      case "--timeout": {
        const seconds = Number(argv[++i]);
        if (!Number.isFinite(seconds) || seconds <= 0) {
          console.error("--timeout expects a positive number of seconds");
          process.exit(2);
        }
        args.timeoutSeconds = seconds;
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
    return 0;
  }
  const repl = args.help
    ? false
    : args.task.length === 0 && !args.listSessions && process.stdin.isTTY;
  if (args.help || (args.task.length === 0 && !args.listSessions && !repl)) {
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
  const jsonMode = args.report === "json";
  if (jsonMode) setUiOutput(process.stderr);

  const store = new SessionStore();

  if (args.listSessions) {
    const sessions = store.recentSessions(workspaceRoot, 10);
    if (sessions.length === 0) {
      process.stdout.write("  no sessions for this workspace yet\n");
    } else {
      process.stdout.write("  recent sessions\n");
      for (const session of sessions) {
        const when = new Date(session.created_at).toISOString().slice(0, 16).replace("T", " ");
        process.stdout.write(
          `    ${session.id.slice(0, 8)}  ${session.state.padEnd(18)} ${when}  ${session.task.slice(0, 60)}\n`,
        );
      }
    }
    store.close();
    return 0;
  }

  const wantsAnthropic =
    args.provider === "anthropic" ||
    (!process.env.NEBIUS_API_KEY && Boolean(process.env.ANTHROPIC_API_KEY));
  if (wantsAnthropic ? !process.env.ANTHROPIC_API_KEY : !process.env.NEBIUS_API_KEY) {
    process.stdout.write(firstRun());
    console.error(
      wantsAnthropic
        ? "ANTHROPIC_API_KEY is not set."
        : "NEBIUS_API_KEY is not set. Get a key at https://tokenfactory.nebius.com and add it to .env",
    );
    store.close();
    return 2;
  }

  const { gateway, label } = selectGateway({
    provider: args.provider ?? config.provider,
    model: args.model ?? config.model,
  });

  if (!jsonMode) process.stdout.write(`${banner(workspaceRoot)}\n  ${label}\n\n`);

  const readline = createInterface({ input: process.stdin, output: process.stderr });
  const autoApprove = args.yes || mode === "auto";
  const sessionAlways = new Set<string>();
  const approver = async (request: ApprovalRequest): Promise<ApprovalOutcome> => {
    if (sessionAlways.has(request.summary)) return { approved: true };
    if (autoApprove && request.tier !== "high_impact") {
      process.stderr.write(`  · auto-approved: ${request.summary}\n`);
      return { approved: true };
    }
    if (request.summary === "Approve plan" && request.detail) {
      printPlan(request.detail);
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
    const answer = (await readline.question(`  allow? ${request.summary} [y]es/[a]lways/[N]o: `))
      .trim()
      .toLowerCase();
    if (answer === "a" || answer === "always") {
      sessionAlways.add(request.summary);
      return { approved: true };
    }
    return { approved: answer === "y" || answer === "yes" };
  };

  const onEvent = (event: AgentEvent): void => {
    switch (event.type) {
      case "state":
        printState(event.to);
        break;
      case "text":
        printText(event.text);
        break;
      case "plan":
        break;
      case "tool":
        printTool(event.name, event.input, event.decision);
        break;
      case "tool_result":
        printToolResult(event.name, event.ok, event.summary);
        break;
      case "usage":
        printUsage(event.prompt, event.completion);
        break;
      case "report":
        printReport(event.report);
        break;
      case "approval":
        break;
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
    commandTimeoutMs: timeoutSeconds !== undefined ? timeoutSeconds * 1000 : undefined,
    priorContext,
  });

  let active: AbortController | null = null;
  process.on("SIGINT", () => {
    if (active && !active.signal.aborted) {
      active.abort();
      return;
    }
    readline.close();
    process.exit(130);
  });

  const runOne = async (task: string): Promise<CompletionReport> => {
    const controller = new AbortController();
    active = controller;
    try {
      return await agent.run(task, { signal: controller.signal });
    } finally {
      active = null;
    }
  };

  try {
    if (!repl) {
      const report = await runOne(args.task);
      if (jsonMode) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return exitCodeFor(report);
    }

    process.stdout.write("\n  interactive session — type a task, or /help, /clear, /quit\n");
    while (true) {
      let line = "";
      try {
        line = (await readline.question("\nterminus › ")).trim();
      } catch {
        break;
      }
      if (line.length === 0) continue;
      if (line === "/quit" || line === "/exit") break;
      if (line === "/clear") {
        agent.reset();
        process.stdout.write("  session context cleared\n");
        continue;
      }
      if (line === "/help") {
        process.stdout.write(
          "  /clear   forget conversation context\n  /sessions  list recent sessions\n  /quit     exit\n",
        );
        continue;
      }
      if (line === "/sessions") {
        for (const session of store.recentSessions(workspaceRoot, 10)) {
          process.stdout.write(
            `  ${session.id.slice(0, 8)}  ${session.state.padEnd(18)} ${session.task.slice(0, 60)}\n`,
          );
        }
        continue;
      }
      await runOne(line);
    }
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
