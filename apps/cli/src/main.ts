#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { runTask } from "@terminus/agent-runtime";
import { anthropicGateway } from "@terminus/model-gateway";
import { SessionStore } from "@terminus/session-store";
import type { AgentEvent, ApprovalOutcome, ApprovalRequest, Mode } from "@terminus/shared";
import {
  banner,
  firstRun,
  printPlan,
  printReport,
  printState,
  printText,
  printTool,
  printToolResult,
} from "./ui";

interface CliArgs {
  task: string;
  dir: string;
  mode: Mode;
  yes: boolean;
  model?: string;
  verify: string[];
  help: boolean;
}

const parseArgs = (argv: string[]): CliArgs => {
  const args: CliArgs = { task: "", dir: ".", mode: "act", yes: false, verify: [], help: false };
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
      case "--dir":
        args.dir = argv[++i] ?? ".";
        break;
      case "--mode": {
        const mode = argv[++i];
        if (mode === "ask" || mode === "plan" || mode === "act" || mode === "auto")
          args.mode = mode;
        else {
          console.error(`unknown mode: ${mode}`);
          process.exit(2);
        }
        break;
      }
      case "--model":
        args.model = argv[++i];
        break;
      case "--verify":
        args.verify.push(...(argv[++i] ?? "").split(",").filter(Boolean));
        break;
      default:
        words.push(arg);
    }
  }
  args.task = words.join(" ").trim();
  return args;
};

const main = async (): Promise<number> => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.task.length === 0) {
    process.stdout.write(firstRun());
    return args.help ? 0 : 2;
  }

  const workspaceRoot = resolve(args.dir);
  if (!existsSync(workspaceRoot)) {
    console.error(`directory not found: ${workspaceRoot}`);
    return 2;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    process.stdout.write(firstRun());
    console.error("ANTHROPIC_API_KEY is not set. Export it and try again.");
    return 2;
  }

  process.stdout.write(`${banner(workspaceRoot)}\n\n`);

  const readline = createInterface({ input: process.stdin, output: process.stdout });
  const autoApprove = args.yes || args.mode === "auto";
  const approver = async (request: ApprovalRequest): Promise<ApprovalOutcome> => {
    if (autoApprove && request.tier !== "high_impact") {
      process.stdout.write(`  ${"·"} auto-approved: ${request.summary}\n`);
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
    const answer = (await readline.question(`  allow? ${request.summary} [y/N]: `))
      .trim()
      .toLowerCase();
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
      case "report":
        printReport(event.report);
        break;
      case "approval":
        break;
    }
  };

  const controller = new AbortController();
  process.on("SIGINT", () => {
    readline.close();
    controller.abort();
  });

  const store = new SessionStore();
  try {
    const report = await runTask(args.task, {
      workspaceRoot,
      gateway: anthropicGateway({ model: args.model }),
      approver,
      emit: onEvent,
      mode: args.mode,
      store,
      verifyCommands: args.verify.length > 0 ? args.verify : undefined,
      signal: controller.signal,
    });
    return report.outcome === "completed" ? 0 : report.outcome === "cancelled" ? 2 : 1;
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
