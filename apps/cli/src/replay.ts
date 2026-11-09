import type { SessionStore } from "@terminus/session-store";
import type { CompletionReport } from "@terminus/shared";
import { clip, fitWidth } from "./fit";

export interface ReplayOptions {
  write?: (text: string) => void;
  verbose?: boolean;
}

export function replaySession(
  store: SessionStore,
  sessionId: string,
  options: ReplayOptions = {},
): boolean {
  const write = options.write ?? ((t: string) => process.stdout.write(t));
  const session = store.sessionById(sessionId);

  if (!session) {
    write(`  error: no session matches id "${sessionId}"\n`);
    return false;
  }

  const events = store.eventsOf(session.id);
  const width = Math.max(40, fitWidth());
  const dateStr = new Date(session.created_at).toISOString().replace("T", " ").slice(0, 19);

  write(`\n  \x1b[1mTERMINUS SESSION REPLAY\x1b[0m\n`);
  write(`  ${"─".repeat(Math.min(width - 4, 70))}\n`);
  write(`  ID:        ${session.id}\n`);
  write(`  Task:      ${clip(session.task, width - 16)}\n`);
  write(`  Workspace: ${clip(session.workspace, width - 16)}\n`);
  write(`  Started:   ${dateStr}\n`);
  write(`  State:     ${session.state}\n`);
  write(`  ${"─".repeat(Math.min(width - 4, 70))}\n\n`);

  if (events.length === 0) {
    write("  no events recorded for this session\n\n");
    return true;
  }

  for (let i = 0; i < events.length; i++) {
    const row = events[i];
    if (!row) continue;

    let payload: unknown;
    try {
      payload = JSON.parse(row.payload);
    } catch {
      payload = row.payload;
    }

    const timeOffset =
      `+${Math.max(0, Math.round((row.at - session.created_at) / 1000))}s`.padStart(6);

    switch (row.type) {
      case "state": {
        const p = payload as { to?: string };
        write(
          `  \x1b[90m${timeOffset}\x1b[0m  \x1b[36m[STATE]\x1b[0m    transitioned to \x1b[1m${p.to ?? "unknown"}\x1b[0m\n`,
        );
        break;
      }
      case "tool": {
        const p = payload as {
          name?: string;
          input?: Record<string, unknown>;
          decision?: { verdict?: string; tier?: string };
        };
        const summary = p.input
          ? Object.entries(p.input)
              .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
              .join(" ")
          : "";
        const verdictColor =
          p.decision?.verdict === "allow"
            ? "\x1b[32m"
            : p.decision?.verdict === "ask"
              ? "\x1b[33m"
              : "\x1b[31m";
        write(
          `  \x1b[90m${timeOffset}\x1b[0m  \x1b[35m[TOOL]\x1b[0m     \x1b[1m${p.name}\x1b[0m (${verdictColor}${p.decision?.verdict ?? "eval"}\x1b[0m tier=${p.decision?.tier ?? "?"}) ${clip(summary, width - 36)}\n`,
        );
        break;
      }
      case "tool_result": {
        const p = payload as { name?: string; ok?: boolean; summary?: string };
        const status = p.ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
        write(
          `  \x1b[90m${timeOffset}\x1b[0m  \x1b[90m[RESULT]\x1b[0m   ${status} ${p.name ?? "tool"}: ${clip(p.summary ?? "", width - 32)}\n`,
        );
        break;
      }
      case "approval": {
        const p = payload as { question?: string; approved?: boolean };
        const verdict = p.approved ? "\x1b[32mAPPROVED\x1b[0m" : "\x1b[31mDECLINED\x1b[0m";
        write(
          `  \x1b[90m${timeOffset}\x1b[0m  \x1b[33m[APPROVE]\x1b[0m  ${verdict}: ${clip(p.question ?? "", width - 32)}\n`,
        );
        break;
      }
      case "report": {
        const p = payload as CompletionReport;
        write(`\n  \x1b[1mFINAL REPORT\x1b[0m\n`);
        write(
          `  Outcome: ${p.outcome === "completed" ? "\x1b[32mcompleted\x1b[0m" : `\x1b[31m${p.outcome}\x1b[0m`}\n`,
        );
        if (p.changedFiles && p.changedFiles.length > 0) {
          write(`  Changed: ${p.changedFiles.join(", ")}\n`);
        }
        if (p.checks && p.checks.length > 0) {
          write(
            `  Checks:  ${p.checks.map((c) => `${c.command} (${c.passed ? "pass" : "fail"})`).join(", ")}\n`,
          );
        }
        if (p.review) {
          write(`  Review:  ${p.review.verdict} — ${clip(p.review.summary, width - 20)}\n`);
        }
        write(`  Summary: ${clip(p.summary, width - 14)}\n\n`);
        break;
      }
      default: {
        // Skip high-frequency events unless verbose
        if (options.verbose) {
          write(
            `  \x1b[90m${timeOffset}\x1b[0m  [${row.type}] ${clip(JSON.stringify(payload), width - 24)}\n`,
          );
        }
      }
    }
  }

  return true;
}
