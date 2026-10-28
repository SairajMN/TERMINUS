import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildRepoMap,
  EvidenceStore,
  hydrateCapsule,
  loadInstructions,
  parseCapsule,
} from "@terminus/context-engine";
import type { ChatMessage, ContentPart, ModelGateway } from "@terminus/model-gateway";
import { toToolSpecs } from "@terminus/model-gateway";
import { PermissionEngine } from "@terminus/permission-engine";
import { webResearch } from "@terminus/research";
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
import { buildChatMessage, buildSystemPrompt, buildTaskMessage } from "./prompt";

const MAX_ITERATIONS = 30;
const MAX_REPLAN_ATTEMPTS = 3;
const MAX_VERIFY_CYCLES = 2;
const MAX_REVIEW_CYCLES = 1;
const RESULT_CHAR_BUDGET = 12_000;
const OUTPUT_CHAR_BUDGET = 8_000;
const READ_ONLY_TOOLS = new Set(["list_dir", "read_file", "search", "git_status", "git_diff"]);

export interface RunTaskOptions {
  workspaceRoot: string;
  gateway: ModelGateway;
  approver: Approver;
  emit?: Emit;
  mode?: Mode;
  store?: SessionStore;
  verifyCommands?: string[];
  maxIterations?: number;
  commandTimeoutMs?: number;
  priorContext?: string;
  signal?: AbortSignal;
}

export interface AgentSession {
  run(task: string, overrides?: { signal?: AbortSignal }): Promise<CompletionReport>;
  chat(message: string, overrides?: { signal?: AbortSignal }): Promise<string>;
  reset(): void;
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

export function createAgent(options: RunTaskOptions): AgentSession {
  const messages: ChatMessage[] = [];
  let evidence = new EvidenceStore();
  let bootstrapped = false;

  const root = options.workspaceRoot;

  const ensureBootstrapped = (): { instructions: string | null; repoMap: string } => {
    if (bootstrapped) {
      const map = evidence.all().find((item) => item.source === "repository map");
      const guide = evidence.all().find((item) => item.source === "project instructions");
      return {
        instructions: typeof guide?.content === "string" ? guide.content : null,
        repoMap: typeof map?.content === "string" ? map.content : "",
      };
    }
    bootstrapped = true;
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
    return { instructions, repoMap };
  };

  const chat = async (message: string, overrides?: { signal?: AbortSignal }): Promise<string> => {
    const emit: Emit = options.emit ?? (() => {});
    const controller = new AbortController();
    const incoming = overrides?.signal ?? options.signal;
    if (incoming?.aborted) controller.abort();
    else incoming?.addEventListener("abort", () => controller.abort(), { once: true });

    const { instructions, repoMap } = ensureBootstrapped();
    messages.push({
      role: "user",
      content: [{ type: "text", text: buildChatMessage(message, repoMap, instructions) }],
    });
    let reply = "";
    const parts: ContentPart[] = [];
    try {
      for await (const event of options.gateway.complete(
        { system: buildSystemPrompt(root, "ask"), messages, tools: [] },
        controller.signal,
      )) {
        if (event.type === "text") {
          reply += event.text;
          emit({ type: "text", text: event.text });
        } else if (event.type === "usage") {
          emit({ type: "usage", prompt: event.prompt, completion: event.completion });
        }
      }
    } catch (error) {
      messages.pop();
      throw error;
    }
    if (reply) parts.push({ type: "text", text: reply });
    messages.push({
      role: "assistant",
      content: parts.length > 0 ? parts : [{ type: "text", text: "" }],
    });
    return reply.trim();
  };

  const run = async (
    task: string,
    overrides?: { signal?: AbortSignal },
  ): Promise<CompletionReport> => {
    const emit: Emit = options.emit ?? (() => {});
    const mode = options.mode ?? "act";
    const machine = new TaskMachine();
    const controller = new AbortController();
    const incoming = overrides?.signal ?? options.signal;
    if (incoming?.aborted) controller.abort();
    else incoming?.addEventListener("abort", () => controller.abort(), { once: true });

    const sessionId = options.store?.createSession(root, task);
    const state = (next: Parameters<TaskMachine["to"]>[0]) => {
      const from = machine.state;
      machine.to(next);
      if (sessionId) options.store?.setState(sessionId, next);
      emit({ type: "state", from, to: next });
    };

    const engine = new PermissionEngine({ workspaceRoot: root, mode: "plan" });
    const tools = [...createTools(), webResearch as unknown as ToolDefinition<never>];
    const toolByName = new Map(tools.map((tool) => [tool.name, tool]));
    const changedFiles = new Set<string>();
    const commands: string[] = [];
    const maxIterations = options.maxIterations ?? MAX_ITERATIONS;
    const tokens = { prompt: 0, completion: 0 };
    let finalReview: CompletionReport["review"];

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
        commandTimeoutMs: options.commandTimeoutMs,
      });
      if (action?.kind === "file_write" && result.ok) {
        changedFiles.add(action.path);
        evidence.invalidate(action.path);
      }
      if (call.name === "web_research" && result.ok) {
        evidence.add({
          kind: "documentation",
          source: `web research: ${String((parsed.data as { query?: string }).query ?? "")}`,
          content: result.output,
          trustLevel: "untrusted",
          relevance: 0.7,
        });
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
          } else if (event.type === "usage") {
            tokens.prompt += event.prompt;
            tokens.completion += event.completion;
            emit({ type: "usage", prompt: event.prompt, completion: event.completion });
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
          assistantParts.push({
            type: "tool_use",
            id: call.id,
            name: call.name,
            input: call.input,
          });
        }
        messages.push({ role: "assistant", content: assistantParts });
        const results: (ContentPart | null)[] = toolCalls.map(() => null);
        const reads: { call: (typeof toolCalls)[number]; index: number }[] = [];
        const writes: { call: (typeof toolCalls)[number]; index: number }[] = [];
        toolCalls.forEach((call, index) => {
          (READ_ONLY_TOOLS.has(call.name) ? reads : writes).push({ call, index });
        });
        const settled = await Promise.allSettled(reads.map(({ call }) => executeTool(call)));
        settled.forEach((outcome, at) => {
          const slot = reads[at] as { call: (typeof toolCalls)[number]; index: number };
          results[slot.index] =
            outcome.status === "fulfilled"
              ? outcome.value
              : {
                  type: "tool_result",
                  tool_use_id: slot.call.id,
                  content: `tool crashed: ${String(outcome.reason)}`,
                  is_error: true,
                };
        });
        for (const { call, index } of writes) results[index] = await executeTool(call);
        messages.push({ role: "user", content: results as ContentPart[] });
      }
    };

    const runVerification = async (): Promise<CheckResult[]> => {
      const planned = options.verifyCommands ?? detectVerifications(root);
      const checks: CheckResult[] = [];
      const approved: string[] = [];
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
        approved.push(command);
      }
      const outcomes = await Promise.allSettled(
        approved.map((command) => runCommand(command, { cwd: root, signal: controller.signal })),
      );
      outcomes.forEach((outcome, index) => {
        const command = approved[index] as string;
        commands.push(command);
        const result =
          outcome.status === "fulfilled"
            ? outcome.value
            : { exitCode: 1, output: String(outcome.reason), truncated: false, timedOut: false };
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
      });
      return checks;
    };

    const runReview = async (): Promise<{ verdict: "clear" | "issues"; findings: string }> => {
      messages.push({
        role: "user",
        content: [
          {
            type: "text",
            text: `Post-change review for this task: ${task}\n\nUse git_diff and read the files you changed. Look for bugs, security problems, risky code without a test, performance issues, and anything contradicting the acceptance criteria. Start each finding line with - blocker: or - major: or - minor:. If nothing is at blocker or major level, end your reply with exactly: verdict: clear`,
          },
        ],
      });
      const findings = clip(
        (await runTurn(tools.filter((tool) => tool.tier === "read"))).trim(),
        4_000,
      );
      const verdict = /-\s*(blocker|major):/i.test(findings)
        ? ("issues" as const)
        : ("clear" as const);
      finalReview = { verdict, summary: findings };
      return { verdict, findings };
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
        tokens: tokens.prompt + tokens.completion > 0 ? { ...tokens } : undefined,
        review: finalReview,
      });
    };

    try {
      state("investigating");
      const { instructions, repoMap } = ensureBootstrapped();
      let prior = "";
      if (options.priorContext) {
        const parsedCapsule = parseCapsule(options.priorContext);
        if (parsedCapsule) {
          const hydrated = hydrateCapsule(parsedCapsule, root, evidence);
          prior = `\n\n${hydrated.prompt}`;
        } else {
          prior = `\n\n${options.priorContext}`;
        }
      }
      const firstMessage = messages.length === 0;
      messages.push({
        role: "user",
        content: [
          {
            type: "text",
            text: firstMessage
              ? `${buildTaskMessage(task, repoMap, instructions, mode)}${prior}`
              : `New task in this session: ${task}`,
          },
        ],
      });

      const readTools = tools.filter((tool) => tool.tier === "read");

      if (mode === "ask") {
        await runTurn(readTools);
        return finish("completed", "Answered.");
      }
      if (mode === "audit") {
        await runTurn(readTools);
        return finish("completed", "Audit produced.");
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
      let reviewCycles = 0;
      while (true) {
        await runTurn(tools);
        state("verifying");
        checks = await runVerification();
        const failedNow = checks.filter((check) => !check.passed);
        if (failedNow.length > 0) {
          if (cycles >= MAX_VERIFY_CYCLES) break;
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
          continue;
        }
        state("reviewing");
        const review = await runReview();
        if (review.verdict === "issues" && reviewCycles < MAX_REVIEW_CYCLES) {
          reviewCycles++;
          state("diagnosing");
          messages.push({
            role: "user",
            content: [
              {
                type: "text",
                text: `Your post-change review found issues:\n\n${review.findings}\n\nFix the blockers and majors, keep the changes minimal, then stop so verification and review can run again.`,
              },
            ],
          });
          state("implementing");
          continue;
        }
        break;
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
        tokens: tokens.prompt + tokens.completion > 0 ? { ...tokens } : undefined,
      });
    }
  };

  return {
    run,
    chat,
    reset: () => {
      messages.length = 0;
      evidence = new EvidenceStore();
      bootstrapped = false;
    },
  };
}

export const runTask = (task: string, options: RunTaskOptions): Promise<CompletionReport> =>
  createAgent(options).run(task);
