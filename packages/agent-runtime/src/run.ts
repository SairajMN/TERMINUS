import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildRepoMap, EvidenceStore, loadInstructions } from "@terminus/context-engine";
import type { ChatMessage, ContentPart, ModelGateway } from "@terminus/model-gateway";
import { toToolSpecs } from "@terminus/model-gateway";
import { PermissionEngine } from "@terminus/permission-engine";
import type { SessionStore } from "@terminus/session-store";
import {
  type Approver,
  type CheckResult,
  type CompletionReport,
  type Emit,
  type Mode,
  TaskMachine,
  type ToolDefinition,
} from "@terminus/shared";
import { actionFor, createTools, redact, runCommand } from "@terminus/tool-runtime";
import { z } from "zod";
import { buildSystemPrompt, buildTaskMessage } from "./prompt";

const MAX_ITERATIONS = 30;
const MAX_REPLAN_ATTEMPTS = 3;
const MAX_VERIFY_CYCLES = 2;
const RESULT_CHAR_BUDGET = 12_000;
const OUTPUT_CHAR_BUDGET = 8_000;

export interface RunTaskOptions {
  workspaceRoot: string;
  gateway: ModelGateway;
  approver: Approver;
  emit?: Emit;
  mode?: Mode;
  store?: SessionStore;
  verifyCommands?: string[];
  maxIterations?: number;
  signal?: AbortSignal;
}

const toSpecs = (tools: ToolDefinition<never>[]) =>
  toToolSpecs(
    tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: z.toJSONSchema(tool.schema as z.ZodType, { io: "input" }),
    })),
  );

const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max)}\n… [clipped]` : text;

const summarizeInput = (name: string, input: unknown): string => {
  const value = (input ?? {}) as Record<string, unknown>;
  if (name === "run_command") return String(value.command ?? "");
  if (typeof value.path === "string") return value.path;
  return name;
};

export const detectVerifications = (workspaceRoot: string): string[] => {
  let manifest: { scripts?: Record<string, string> };
  try {
    manifest = JSON.parse(readFileSync(join(workspaceRoot, "package.json"), "utf8"));
  } catch {
    return [];
  }
  const scripts = manifest.scripts ?? {};
  const preferred = ["test", "typecheck", "check", "lint", "build"];
  return preferred
    .filter((name) => scripts[name] !== undefined)
    .slice(0, 3)
    .map((name) => `npm run ${name}`);
};

export async function runTask(task: string, options: RunTaskOptions): Promise<CompletionReport> {
  const emit: Emit = options.emit ?? (() => {});
  const root = options.workspaceRoot;
  const mode = options.mode ?? "act";
  const machine = new TaskMachine();
  const controller = new AbortController();
  options.signal?.addEventListener("abort", () => controller.abort(), { once: true });

  const sessionId = options.store?.createSession(root, task);
  const state = (next: Parameters<TaskMachine["to"]>[0]) => {
    const from = machine.state;
    machine.to(next);
    if (sessionId) options.store?.setState(sessionId, next);
    emit({ type: "state", from, to: next });
  };

  const engine = new PermissionEngine({ workspaceRoot: root, mode: "plan" });
  const evidence = new EvidenceStore();
  const tools = createTools();
  const toolByName = new Map(tools.map((tool) => [tool.name, tool]));
  const changedFiles = new Set<string>();
  const commands: string[] = [];
  const messages: ChatMessage[] = [];
  const maxIterations = options.maxIterations ?? MAX_ITERATIONS;

  const executeTool = async (call: {
    id: string;
    name: string;
    input: unknown;
  }): Promise<ContentPart> => {
    const resultPart = (content: string, isError: boolean): ContentPart => ({
      type: "tool_result",
      tool_use_id: call.id,
      content: clip(content, RESULT_CHAR_BUDGET),
      is_error: isError,
    });
    const tool = toolByName.get(call.name);
    if (!tool) return resultPart(`unknown tool: ${call.name}`, true);
    const parsed = tool.schema.safeParse(call.input);
    if (!parsed.success) {
      return resultPart(
        `invalid input: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
        true,
      );
    }
    const action = actionFor(call.name, parsed.data);
    const decision = action
      ? engine.evaluate(action)
      : { action: "allow" as const, tier: tool.tier, reason: "fixed internal tool" };
    emit({
      type: "tool",
      name: call.name,
      input: parsed.data,
      decision: { verdict: decision.action, tier: decision.tier, reason: decision.reason },
    });
    if (decision.action === "deny") {
      return resultPart(`blocked by policy: ${decision.reason}`, true);
    }
    if (decision.action === "ask" && !(mode === "auto" && decision.tier !== "high_impact")) {
      const outcome = await options.approver({
        summary: `${call.name}: ${summarizeInput(call.name, parsed.data)}`,
        detail: JSON.stringify(parsed.data, null, 2),
        tier: decision.tier,
      });
      emit({
        type: "approval",
        question: `${call.name}: ${summarizeInput(call.name, parsed.data)}`,
        approved: outcome.approved,
      });
      if (!outcome.approved) {
        return resultPart("the user rejected this action", true);
      }
    }
    if (action?.kind === "file_write" && evidence.checkFresh(root, action.path) === "stale") {
      return resultPart(
        `${action.path} changed since it was read (possibly edited outside this session). Re-read it, then retry.`,
        true,
      );
    }
    const result = await tool.execute(parsed.data as never, {
      workspaceRoot: root,
      signal: controller.signal,
    });
    if (action?.kind === "file_write" && result.ok) {
      changedFiles.add(action.path);
      evidence.invalidate(action.path);
    }
    if (action?.kind === "file_read" && call.name === "read_file" && result.ok) {
      try {
        evidence.recordRead(root, action.path, readFileSync(join(root, action.path), "utf8"));
      } catch {
        evidence.invalidate(action.path);
      }
    }
    emit({
      type: "tool_result",
      name: call.name,
      ok: result.ok,
      summary: clip(result.output, 300),
    });
    return resultPart(result.output, !result.ok);
  };

  const runTurn = async (allowed: ToolDefinition<never>[]): Promise<string> => {
    const specs = toSpecs(allowed);
    let iterations = 0;
    while (true) {
      if (++iterations > maxIterations) throw new Error("iteration budget exhausted");
      let narration = "";
      const toolCalls: { id: string; name: string; input: unknown }[] = [];
      for await (const event of options.gateway.complete(
        {
          system: buildSystemPrompt(root, mode),
          messages,
          tools: specs,
        },
        controller.signal,
      )) {
        if (event.type === "text") {
          narration += event.text;
          emit({ type: "text", text: event.text });
        } else {
          toolCalls.push(event);
        }
      }
      if (toolCalls.length === 0) {
        if (narration) {
          messages.push({ role: "assistant", content: [{ type: "text", text: narration }] });
        }
        return narration;
      }
      const assistantParts: ContentPart[] = [];
      if (narration) assistantParts.push({ type: "text", text: narration });
      for (const call of toolCalls) {
        assistantParts.push({ type: "tool_use", id: call.id, name: call.name, input: call.input });
      }
      messages.push({ role: "assistant", content: assistantParts });
      const results: ContentPart[] = [];
      for (const call of toolCalls) results.push(await executeTool(call));
      messages.push({ role: "user", content: results });
    }
  };

  const runVerification = async (): Promise<CheckResult[]> => {
    const planned = options.verifyCommands ?? detectVerifications(root);
    const checks: CheckResult[] = [];
    for (const command of planned) {
      const decision = engine.evaluate({ kind: "command", command });
      emit({
        type: "tool",
        name: "run_command",
        input: { command, verification: true },
        decision: { verdict: decision.action, tier: decision.tier, reason: decision.reason },
      });
      if (decision.action === "deny") {
        checks.push({
          name: command,
          command,
          passed: false,
          output: `blocked by policy: ${decision.reason}`,
        });
        continue;
      }
      if (decision.action === "ask") {
        const outcome = await options.approver({
          summary: `verify: ${command}`,
          tier: decision.tier,
        });
        emit({ type: "approval", question: `verify: ${command}`, approved: outcome.approved });
        if (!outcome.approved) {
          checks.push({
            name: command,
            command,
            passed: false,
            output: "the user declined verification",
          });
          continue;
        }
      }
      commands.push(command);
      const result = await runCommand(command, { cwd: root, signal: controller.signal });
      const output = clip(redact(result.output || "(no output)"), OUTPUT_CHAR_BUDGET);
      checks.push({
        name: command,
        command,
        passed: result.exitCode === 0,
        output: result.exitCode === 0 ? output : `exit code: ${result.exitCode}\n\n${output}`,
      });
      emit({
        type: "tool_result",
        name: "run_command",
        ok: result.exitCode === 0,
        summary: clip(output, 300),
      });
    }
    return checks;
  };

  const finalize = (completion: CompletionReport): CompletionReport => {
    emit({ type: "report", report: completion });
    if (sessionId) options.store?.logReport(sessionId, completion);
    return completion;
  };

  const finish = (
    outcome: CompletionReport["outcome"],
    summary: string,
    checks: CheckResult[] = [],
  ): CompletionReport => {
    if (!machine.finished) {
      if (machine.state === "failed_check")
        state(outcome === "completed" ? "completed" : "cancelled");
      else state(outcome === "completed" ? "completed" : "cancelled");
    }
    return finalize({
      outcome,
      summary,
      changedFiles: [...changedFiles].sort(),
      commands,
      checks,
    });
  };

  try {
    state("investigating");
    const instructions = loadInstructions(root);
    if (instructions) {
      evidence.add({
        kind: "instruction",
        source: "project instructions",
        content: instructions,
        trustLevel: "trusted",
        relevance: 1,
      });
    }
    const repoMap = buildRepoMap(root);
    evidence.add({
      kind: "documentation",
      source: "repository map",
      content: repoMap,
      relevance: 0.8,
    });
    messages.push({
      role: "user",
      content: [{ type: "text", text: buildTaskMessage(task, repoMap, instructions, mode) }],
    });

    const readTools = tools.filter((tool) => tool.tier === "read");

    if (mode === "ask") {
      await runTurn(readTools);
      return finish("completed", "Answered.");
    }

    state("planning");
    let plan = await runTurn(readTools);
    emit({ type: "plan", text: plan });

    if (mode === "plan") {
      return finish("completed", "Plan produced.");
    }

    let approved = false;
    for (let attempt = 0; attempt <= MAX_REPLAN_ATTEMPTS; attempt++) {
      state("awaiting_approval");
      const outcome = await options.approver({
        summary: "Approve plan",
        detail: plan,
        tier: "modify",
      });
      emit({ type: "approval", question: "approve plan", approved: outcome.approved });
      if (outcome.approved) {
        approved = true;
        break;
      }
      if (!outcome.feedback) break;
      messages.push({
        role: "user",
        content: [
          {
            type: "text",
            text: `Plan not approved. Feedback: ${outcome.feedback}\n\nRevise the plan accordingly.`,
          },
        ],
      });
      state("planning");
      plan = await runTurn(readTools);
      emit({ type: "plan", text: plan });
    }
    if (!approved) {
      return finish("cancelled", "Plan not approved. Nothing was changed.");
    }

    engine.mode = mode;
    state("implementing");
    let checks: CheckResult[] = [];
    let cycles = 0;
    while (true) {
      await runTurn(tools);
      state("verifying");
      checks = await runVerification();
      const failedNow = checks.filter((check) => !check.passed);
      if (failedNow.length === 0 || cycles >= MAX_VERIFY_CYCLES) break;
      cycles++;
      state("failed_check");
      state("diagnosing");
      messages.push({
        role: "user",
        content: [
          {
            type: "text",
            text: `Verification failed:\n\n${failedNow
              .map((check) => `$ ${check.command}\n${check.output}`)
              .join(
                "\n\n",
              )}\n\nFix the root cause, keep changes minimal, then stop so verification can run again.`,
          },
        ],
      });
      state("implementing");
    }
    const failed = checks.filter((check) => !check.passed);
    if (failed.length > 0) {
      return finish(
        "failed",
        `Stopped with ${failed.length} failing check(s): ${failed.map((check) => check.command).join(", ")}`,
        checks,
      );
    }
    return finish(
      "completed",
      checks.length > 0
        ? `Done. ${checks.length} check(s) passed; ${changedFiles.size} file(s) changed.`
        : "Done. No verification commands were found in the project; no checks were run.",
      checks,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!machine.finished) {
      try {
        state("cancelled");
      } catch {
        machine.state = "cancelled";
      }
    }
    return finalize({
      outcome: controller.signal.aborted ? "cancelled" : "failed",
      summary: message,
      changedFiles: [...changedFiles].sort(),
      commands,
      checks: [],
    });
  }
}
