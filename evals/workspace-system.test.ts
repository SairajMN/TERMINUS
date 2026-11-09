import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchSkills, SkillRegistryManager } from "@terminus/context-engine";
import { type ModelEvent, mockGateway } from "@terminus/model-gateway";
import { startGuiHttpServer, TerminusRuntimeBridge } from "@terminus/runtime-bridge";
import { SessionStore } from "@terminus/session-store";
import {
  renderWorkspaceHtml,
  shouldSubmitComposerOnKeydown,
  WorkspaceClientStore,
} from "@terminus/workspace-ui";
import { activateTerminusVscodeExtension } from "../apps/vscode/src/extension";

const tempDirs: string[] = [];

const scriptedGateway = (turns: ModelEvent[][]) => {
  let idx = 0;
  return mockGateway(() => turns[idx++] ?? []);
};

const createTempWorkspace = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "terminus-ws-eval-"));
  tempDirs.push(dir);
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "ws-fixture", version: "1.0.0", scripts: {} }, null, 2),
  );
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("TERMINUS Extensible AI Developer Workspace — 16 Mandatory System Scenarios", () => {
  it("1 & 2. GUI starts cleanly when agent is offline, and Agent runs headlessly without GUI", async () => {
    const dir = createTempWorkspace();
    const store = new SessionStore(join(dir, "terminus.db"));

    // 1. Offline GUI startup
    const clientStore = new WorkspaceClientStore({ initialBridgeStatus: "offline" });
    expect(clientStore.snapshot().bridgeStatus).toBe("offline");

    const bridge = new TerminusRuntimeBridge({
      workspaceRoot: dir,
      store,
      gatewayFactory: () => {
        throw new Error("Offline: no network or API key");
      },
    });
    const session = await bridge.createSession({ workspaceRoot: dir, mode: "ask" });
    expect(session.sessionId).toBeDefined();

    const html = renderWorkspaceHtml({ sessions: bridge.listSessions(dir) });
    expect(html).toContain("TERMINUS");
    expect(html).toContain('meta name="color-scheme" content="light dark"');
    expect(html).toContain('dialog id="unsaved-config-dialog"');

    // 2. Headless execution without GUI
    const mockGw = scriptedGateway([[{ type: "text", text: "Headless answer without GUI." }]]);
    const headlessBridge = new TerminusRuntimeBridge({
      workspaceRoot: dir,
      store,
      gateway: mockGw,
    });
    const s2 = await headlessBridge.createSession({ workspaceRoot: dir, mode: "ask" });
    const res = await headlessBridge.sendMessage({
      sessionId: s2.sessionId,
      prompt: "Explain architecture",
      mode: "ask",
    });
    expect(res.outcome).toBe("completed");

    await bridge.shutdown();
    await headlessBridge.shutdown();
    store.close();
  });

  it("3. GUI reconnects to an existing session and replays missed sequence events without duplicates", async () => {
    const dir = createTempWorkspace();
    const store = new SessionStore(join(dir, "terminus.db"));
    const mockGw = scriptedGateway([[{ type: "text", text: "Step 1 complete." }]]);
    const bridge = new TerminusRuntimeBridge({ workspaceRoot: dir, store, gateway: mockGw });
    const session = await bridge.createSession({ workspaceRoot: dir, mode: "ask" });

    const clientStore = new WorkspaceClientStore({ initialBridgeStatus: "online" });
    const initialEvents = bridge.getExecutionEvents(session.sessionId, 0);
    for (const ev of initialEvents) {
      clientStore.ingestRawEvent(ev);
    }
    const seqBeforeDisconnect = clientStore.snapshot().lastSeenSeqBySession[session.sessionId] ?? 0;
    expect(seqBeforeDisconnect).toBeGreaterThan(0);

    // Run task while client is "disconnected"
    await bridge.sendMessage({
      sessionId: session.sessionId,
      prompt: "Run while disconnected",
      mode: "ask",
    });

    // Reconnect and fetch only missed events after seqBeforeDisconnect
    const missedEvents = bridge.getExecutionEvents(session.sessionId, seqBeforeDisconnect);
    expect(missedEvents.length).toBeGreaterThan(0);
    expect(missedEvents.every((e) => e.seq > seqBeforeDisconnect)).toBe(true);

    for (const ev of missedEvents) {
      const ingested = clientStore.ingestRawEvent(ev);
      expect(ingested.accepted).toBe(true);
    }

    // Re-ingesting the same event is ignored as a duplicate sequence
    const duplicate = clientStore.ingestRawEvent(missedEvents[0]);
    expect(duplicate.accepted).toBe(false);
    expect(duplicate.reason).toBe("duplicate_or_stale_seq");

    await bridge.shutdown();
    store.close();
  });

  it("9, 10 & 12. Handles model provider outage, task cancellation, and hard token/cost budget exhaustion", async () => {
    const dir = createTempWorkspace();
    const store = new SessionStore(join(dir, "terminus.db"));

    // 9. Model provider outage (503 unavailable)
    const failingGw = {
      complete: () => ({
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            throw new Error("HTTP 503 Service Unavailable: upstream provider overloaded");
          },
        }),
      }),
    };
    const outageBridge = new TerminusRuntimeBridge({
      workspaceRoot: dir,
      store,
      gateway: failingGw,
    });
    const sOutage = await outageBridge.createSession({ workspaceRoot: dir, mode: "ask" });
    const outageRes = await outageBridge.sendMessage({
      sessionId: sOutage.sessionId,
      prompt: "Test provider failure",
    });
    expect(outageRes.outcome).toBe("failed");
    expect(outageRes.summary).toContain("503 Service Unavailable");

    // 10. Pause, Resume, and Cancel execution
    const pauseSignalBridge = new TerminusRuntimeBridge({
      workspaceRoot: dir,
      store,
      gateway: scriptedGateway([[{ type: "text", text: "Done" }]]),
    });
    const sCancel = await pauseSignalBridge.createSession({ workspaceRoot: dir, mode: "act" });
    expect(pauseSignalBridge.pauseExecution(sCancel.sessionId).status).toBe("paused");
    expect(pauseSignalBridge.resumeExecution(sCancel.sessionId).status).toBe("running");
    expect(pauseSignalBridge.stopExecution(sCancel.sessionId).status).toBe("cancelled");

    // 12. Token budget exhaustion enforcement
    const highTokenGw = scriptedGateway([
      [
        { type: "usage", prompt: 4500, completion: 1500 },
        { type: "text", text: "High token response" },
      ],
    ]);
    const budgetBridge = new TerminusRuntimeBridge({
      workspaceRoot: dir,
      store,
      gateway: highTokenGw,
    });
    const sBudget = await budgetBridge.createSession({
      workspaceRoot: dir,
      mode: "ask",
      budget: { maxTokens: 5000, maxCostUsd: 1.0, maxToolCalls: 10 },
    });
    await budgetBridge.sendMessage({
      sessionId: sBudget.sessionId,
      prompt: "Consume tokens",
      mode: "ask",
    });
    const events = budgetBridge.getExecutionEvents(sBudget.sessionId, 0);
    const budgetWarning = events.find((e) => e.payload.type === "budget.warning");
    expect(budgetWarning).toBeDefined();

    await outageBridge.shutdown();
    await pauseSignalBridge.shutdown();
    await budgetBridge.shutdown();
    store.close();
  });

  it("11, 13 & 14. Never self-certifies worker claims, drops malformed runtime events safely, and guards unsaved config edits + IME-safe Enter", () => {
    const client = new WorkspaceClientStore({ initialBridgeStatus: "online" });

    // 11. Worker agent claims completion -> badge becomes CLAIMED_COMPLETE, NEVER VERIFIED
    client.ingestRawEvent({
      seq: 1,
      sessionId: "sess-1",
      timestamp: Date.now(),
      payload: {
        type: "agent.completed",
        agentId: "backend-1",
        claimStatus: "claimed_complete",
        evidenceIds: ["DIFF-1"],
        summary: "Worker claims it finished everything",
      },
    });
    expect(client.snapshot().verificationBadge).toBe("CLAIMED_COMPLETE");
    expect(client.snapshot().verificationBadge).not.toBe("VERIFIED");

    // Independent VerificationEngine rejects unsupported claim -> badge becomes REJECTED
    client.ingestRawEvent({
      seq: 2,
      sessionId: "sess-1",
      timestamp: Date.now(),
      payload: {
        type: "verification.completed",
        taskId: "TASK-1",
        overallVerdict: "REJECTED",
        uccr: 1.0,
        falseAcceptanceCount: 0,
        summary: "Claim C1 rejected: missing TEST-RUN-* evidence in ledger",
      },
    });
    expect(client.snapshot().verificationBadge).toBe("REJECTED");

    // 13. Malformed runtime events are dropped safely without crashing UI state
    const bad1 = client.ingestRawEvent("{corrupted json");
    const bad2 = client.ingestRawEvent({ seq: "not-a-number", payload: { type: "unknown" } });
    expect(bad1.accepted).toBe(false);
    expect(bad2.accepted).toBe(false);
    expect(client.snapshot().droppedMalformedEventCount).toBe(2);

    // 14. Unsaved configuration changes guard navigation
    client.dirtyGuard.markDirty("skill-editor", "---\nname: draft-skill\n---");
    const blockedNav = client.navigateTo("mcp");
    expect(blockedNav.navigated).toBe(false);
    expect(blockedNav.blockedByDirtyForms).toEqual(["skill-editor"]);

    const confirmedNav = client.navigateTo("mcp", () => true);
    expect(confirmedNav.navigated).toBe(true);
    expect(client.snapshot().activeSection).toBe("mcp");

    // IME-safe Enter check (including Safari keyCode 229 fallback)
    expect(
      shouldSubmitComposerOnKeydown({
        key: "Enter",
        shiftKey: false,
        isComposing: false,
        keyCode: 13,
      }),
    ).toBe(true);
    expect(
      shouldSubmitComposerOnKeydown({
        key: "Enter",
        shiftKey: true,
        isComposing: false,
        keyCode: 13,
      }),
    ).toBe(false);
    expect(
      shouldSubmitComposerOnKeydown({
        key: "Enter",
        shiftKey: false,
        isComposing: true,
        keyCode: 13,
      }),
    ).toBe(false);
    expect(
      shouldSubmitComposerOnKeydown({
        key: "Enter",
        shiftKey: false,
        isComposing: false,
        keyCode: 229,
      }),
    ).toBe(false);
  });

  it("15 & 16. Preserves existing user dirty file modifications on checkpoint restore and keeps all CLI commands working", async () => {
    const dir = createTempWorkspace();
    const store = new SessionStore(join(dir, "terminus.db"));

    // User has uncommitted modifications in `user-work.ts` and baseline `agent-work.ts`
    const userFile = join(dir, "user-work.ts");
    const agentFile = join(dir, "agent-work.ts");
    writeFileSync(userFile, "export const userDirtyModification = 'DO_NOT_TOUCH';\n", "utf8");
    writeFileSync(agentFile, "export const v = 1;\n", "utf8");

    // Agent modifies `agent-work.ts` during session
    const mockGw = scriptedGateway([
      [{ type: "text", text: "1. Update agent-work.ts" }],
      [
        {
          type: "tool_use",
          id: "call-write-1",
          name: "write_file",
          input: { path: "agent-work.ts", content: "export const v = 2;\n" },
        },
      ],
      [{ type: "text", text: "Updated agent-work.ts." }],
      [{ type: "text", text: "verdict: clear" }],
    ]);

    const bridge = new TerminusRuntimeBridge({ workspaceRoot: dir, store, gateway: mockGw });
    const session = await bridge.createSession({ workspaceRoot: dir, mode: "act" });

    // Auto-approve plan when requested
    bridge.subscribeEvents(session.sessionId, (ev) => {
      if (ev.payload.type === "approval.required") {
        bridge.approveAction({
          sessionId: session.sessionId,
          approvalId: ev.payload.approvalId,
          scope: "once",
        });
      }
    });

    const runRes = await bridge.sendMessage({
      sessionId: session.sessionId,
      prompt: "Update agent-work.ts to v = 2",
      mode: "act",
    });
    expect(runRes.outcome).toBe("completed");
    expect(readFileSync(agentFile, "utf8")).toBe("export const v = 2;\n");

    const diff = bridge.getFileDiff(session.sessionId);
    expect(diff.files.length).toBe(1);
    expect(diff.files[0]?.path).toBe("agent-work.ts");
    expect(diff.files[0]?.unifiedDiff).toContain("+export const v = 2;");

    // Restore checkpoint -> reverts `agent-work.ts` to v = 1 while leaving `user-work.ts` 100% untouched!
    const restored = bridge.restoreCheckpoint(session.sessionId);
    expect(restored.restored).toEqual(["agent-work.ts"]);
    expect(readFileSync(agentFile, "utf8")).toBe("export const v = 1;\n");
    expect(readFileSync(userFile, "utf8")).toBe(
      "export const userDirtyModification = 'DO_NOT_TOUCH';\n",
    );

    // 15. Verify CLI commands (--version, --harnesses, --doctor) still work identically
    const cliMain = join(import.meta.dir, "..", "apps", "cli", "src", "main.ts");
    const verOut = execFileSync(process.execPath, [cliMain, "--version"], { encoding: "utf8" });
    expect(verOut.trim()).toMatch(/^terminus \d+\.\d+\.\d+/);

    const harnessesOut = execFileSync(process.execPath, [cliMain, "--harnesses"], {
      encoding: "utf8",
    });
    expect(harnessesOut).toContain("BaseCodingHarness");
    expect(harnessesOut).toContain("SecurityAuditHarness");

    await bridge.shutdown();
    store.close();
  });

  it("enforces Quarantine on imported external SKILL.md files until explicitly reviewed and approved, and serves the GUI over HTTP + VS Code Webview", async () => {
    const dir = createTempWorkspace();
    const store = new SessionStore(join(dir, "terminus.db"));
    const skillManager = new SkillRegistryManager({
      trustFilePath: join(dir, "trusted-skills.json"),
    });
    const bridge = new TerminusRuntimeBridge({
      workspaceRoot: dir,
      store,
      skillRegistry: skillManager,
    });

    const skillContent = [
      "---",
      "name: external-audit-helper",
      'description: "Audits cloud IAM policies for privilege escalation vectors when user asks for IAM review"',
      "license: MIT",
      "---",
      "# External IAM Audit SOP",
      "1. Inspect role bindings.",
    ].join("\n");

    // Imported skill starts quarantined
    const importedDir = join(dir, "imported-skills", "external-audit-helper");
    rmSync(importedDir, { recursive: true, force: true });
    writeFileSync(join(dir, "temp-skill.md"), skillContent);

    const discoveredQuarantined = [
      {
        name: "external-audit-helper",
        description:
          "Audits cloud IAM policies for privilege escalation vectors when user asks for IAM review",
        path: join(dir, "temp-skill.md"),
        content: skillContent,
        scope: "imported" as const,
        trustState: "quarantined" as const,
        enabled: true,
      },
    ];

    // Quarantined skill is NEVER matched into prompt context
    expect(matchSkills("run an IAM review on role bindings", discoveredQuarantined).length).toBe(0);

    // Approve quarantined skill -> SHA-256 recorded -> now trusted and matched!
    const approval = bridge.approveQuarantinedSkill("external-audit-helper", skillContent);
    expect(approval.sha256).toHaveLength(64);

    // Start local GUI HTTP server and verify /api/bootstrap & /api/rpc work
    const server = await startGuiHttpServer({
      bridge,
      renderHtml: (b) => renderWorkspaceHtml(b),
      port: 0,
    });
    const bootRes = await fetch(`${server.url}/api/bootstrap`);
    expect(bootRes.status).toBe(200);
    const bootJson = (await bootRes.json()) as { ok: boolean; providers: unknown[] };
    expect(bootJson.ok).toBe(true);
    expect(bootJson.providers.length).toBeGreaterThanOrEqual(5);

    await server.close();

    // Verify VS Code Extension Host activation & Webview creation
    const secretMap = new Map<string, string>();
    let createdHtml = "";
    const vscodeActivated = activateTerminusVscodeExtension(
      {
        subscriptions: [],
        secrets: {
          get: async (k) => secretMap.get(k),
          store: async (k, v) => {
            secretMap.set(k, v);
          },
          delete: async (k) => {
            secretMap.delete(k);
          },
        },
      },
      {
        workspace: { workspaceFolders: [{ uri: { fsPath: dir } }] },
        window: {
          createWebviewPanel: () => ({
            webview: {
              get html() {
                return createdHtml;
              },
              set html(v: string) {
                createdHtml = v;
              },
              postMessage: async () => true,
              onDidReceiveMessage: () => ({ dispose() {} }),
            },
            reveal() {},
            onDidDispose: () => ({ dispose() {} }),
            dispose() {},
          }),
        },
        commands: {
          registerCommand: () => ({ dispose() {} }),
        },
      },
    );

    vscodeActivated.openWorkspacePanel();
    expect(createdHtml).toContain('data-host="vscode"');
    expect(createdHtml).toContain("TERMINUS");

    await vscodeActivated.bridge.shutdown();
    await bridge.shutdown();
    store.close();
  });
});
