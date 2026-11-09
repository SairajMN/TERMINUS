import {
  dispatchBridgeRpc,
  type SecretVault,
  TerminusRuntimeBridge,
} from "@terminus/runtime-bridge";
import { renderWorkspaceHtml } from "@terminus/workspace-ui";

export interface VscodeSecretStorageLike {
  get(key: string): PromiseLike<string | undefined> | Promise<string | undefined>;
  store(key: string, value: string): PromiseLike<void> | Promise<void>;
  delete(key: string): PromiseLike<void> | Promise<void>;
}

export interface VscodeWebviewLike {
  html: string;
  options?: Record<string, unknown>;
  postMessage(message: unknown): PromiseLike<boolean> | Promise<boolean>;
  onDidReceiveMessage(listener: (message: Record<string, unknown>) => unknown): { dispose(): void };
}

export interface VscodeWebviewPanelLike {
  webview: VscodeWebviewLike;
  reveal(): void;
  onDidDispose(listener: () => void): { dispose(): void };
  dispose(): void;
}

export interface VscodeWebviewViewLike {
  webview: VscodeWebviewLike;
  onDidDispose(listener: () => void): { dispose(): void };
}

export interface VscodeWebviewViewProviderLike {
  resolveWebviewView(
    webviewView: VscodeWebviewViewLike,
    context?: unknown,
    token?: unknown,
  ): void | Promise<void>;
}

export interface VscodeExtensionContextLike {
  subscriptions: { dispose(): void }[];
  secrets: VscodeSecretStorageLike;
  extensionUri?: unknown;
}

export interface VscodeHostApiLike {
  workspace: {
    workspaceFolders?: readonly { uri: { fsPath: string } }[];
  };
  window: {
    createWebviewPanel(
      viewType: string,
      title: string,
      showOptions: number,
      options: { enableScripts: boolean; retainContextWhenHidden: boolean },
    ): VscodeWebviewPanelLike;
    registerWebviewViewProvider?(
      viewId: string,
      provider: VscodeWebviewViewProviderLike,
      options?: { webviewOptions?: { retainContextWhenHidden?: boolean } },
    ): { dispose(): void };
  };
  commands: {
    registerCommand(
      command: string,
      callback: (...args: unknown[]) => unknown,
    ): { dispose(): void };
  };
}

export class VscodeSecretVaultAdapter implements SecretVault {
  private readonly cache = new Map<string, string>();

  constructor(private readonly secrets: VscodeSecretStorageLike) {}

  async getSecret(key: string): Promise<string | undefined> {
    if (this.cache.has(key)) return this.cache.get(key);
    const val = await this.secrets.get(key);
    if (val !== undefined) this.cache.set(key, val);
    return val;
  }

  async setSecret(key: string, value: string): Promise<void> {
    this.cache.set(key, value);
    await this.secrets.store(key, value);
  }

  async deleteSecret(key: string): Promise<void> {
    this.cache.delete(key);
    await this.secrets.delete(key);
  }

  listSecretKeys(): string[] {
    return [...this.cache.keys()].sort();
  }
}

export class TerminusSidebarWebviewProvider implements VscodeWebviewViewProviderLike {
  public static readonly viewId = "terminus.SidebarProvider";
  private currentView: VscodeWebviewViewLike | null = null;

  constructor(
    private readonly bridge: TerminusRuntimeBridge,
    private readonly workspaceRoot: string,
    private readonly onOpenWorkspaceTab?: () => void,
  ) {}

  resolveWebviewView(webviewView: VscodeWebviewViewLike): void {
    this.currentView = webviewView;
    if (webviewView.webview.options) {
      webviewView.webview.options.enableScripts = true;
      webviewView.webview.options.retainContextWhenHidden = true;
    }

    const bootstrap = {
      sessions: this.bridge.listSessions(this.workspaceRoot),
      harnesses: this.bridge.listHarnessesAndAgents(),
      skills: this.bridge.listSkills(this.workspaceRoot),
      mcp: this.bridge.listMcpServers(),
      extensions: this.bridge.listExtensions(),
      providers: this.bridge.listProviders(),
      instructions: this.bridge.getInstructionHierarchy(this.workspaceRoot),
      security: this.bridge.getSecurityOverview(this.workspaceRoot),
      tools: this.bridge.getActiveTools(this.workspaceRoot),
    };

    webviewView.webview.html = renderWorkspaceHtml(bootstrap, {
      hostMode: "vscode",
      title: "TERMINUS",
    });

    const unsubscribeEvents = this.bridge.subscribeEvents("*", (envelope) => {
      void webviewView.webview.postMessage({
        type: "runtime_event",
        envelope,
      });
    });

    const msgSub = webviewView.webview.onDidReceiveMessage(async (msg: Record<string, unknown>) => {
      if (msg.type === "rpc" && typeof msg.method === "string") {
        try {
          if (msg.method === "openWorkspaceTab") {
            this.onOpenWorkspaceTab?.();
            await webviewView.webview.postMessage({
              type: "rpc_response",
              requestId: msg.requestId,
              ok: true,
              result: { opened: true },
            });
            return;
          }
          const result = await dispatchBridgeRpc(
            this.bridge,
            msg.method,
            (msg.params as Record<string, unknown>) ?? {},
          );
          await webviewView.webview.postMessage({
            type: "rpc_response",
            requestId: msg.requestId,
            ok: true,
            result,
          });
        } catch (err) {
          await webviewView.webview.postMessage({
            type: "rpc_response",
            requestId: msg.requestId,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    });

    webviewView.onDidDispose(() => {
      unsubscribeEvents();
      if (typeof msgSub?.dispose === "function") msgSub.dispose();
      this.currentView = null;
    });
  }

  postMessage(message: unknown): PromiseLike<boolean> | Promise<boolean> | undefined {
    return this.currentView?.webview?.postMessage(message);
  }
}

export function activateTerminusVscodeExtension(
  context: VscodeExtensionContextLike,
  vscodeApi: VscodeHostApiLike,
): {
  bridge: TerminusRuntimeBridge;
  openWorkspacePanel: () => VscodeWebviewPanelLike;
  sidebarProvider: TerminusSidebarWebviewProvider;
} {
  const workspaceRoot = vscodeApi.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  const secretVault = new VscodeSecretVaultAdapter(context.secrets);
  const bridge = new TerminusRuntimeBridge({
    workspaceRoot,
    secretVault,
  });

  let activePanel: VscodeWebviewPanelLike | null = null;

  const openWorkspacePanel = (): VscodeWebviewPanelLike => {
    if (activePanel) {
      activePanel.reveal();
      return activePanel;
    }

    const panel = vscodeApi.window.createWebviewPanel(
      "terminus.workspace",
      "TERMINUS Workspace",
      1,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      },
    );
    activePanel = panel;

    const bootstrap = {
      sessions: bridge.listSessions(workspaceRoot),
      harnesses: bridge.listHarnessesAndAgents(),
      skills: bridge.listSkills(workspaceRoot),
      mcp: bridge.listMcpServers(),
      extensions: bridge.listExtensions(),
      providers: bridge.listProviders(),
      instructions: bridge.getInstructionHierarchy(workspaceRoot),
      security: bridge.getSecurityOverview(workspaceRoot),
      tools: bridge.getActiveTools(workspaceRoot),
    };

    panel.webview.html = renderWorkspaceHtml(bootstrap, {
      hostMode: "vscode",
      title: "TERMINUS — AI Software Engineering Workspace",
    });

    const unsubscribeEvents = bridge.subscribeEvents("*", (envelope) => {
      void panel.webview.postMessage({
        type: "runtime_event",
        envelope,
      });
    });

    const msgSub = panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === "rpc" && typeof msg.method === "string") {
        try {
          const result = await dispatchBridgeRpc(
            bridge,
            msg.method,
            (msg.params as Record<string, unknown>) ?? {},
          );
          await panel.webview.postMessage({
            type: "rpc_response",
            requestId: msg.requestId,
            ok: true,
            result,
          });
        } catch (err) {
          await panel.webview.postMessage({
            type: "rpc_response",
            requestId: msg.requestId,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    });

    panel.onDidDispose(() => {
      unsubscribeEvents();
      msgSub.dispose();
      activePanel = null;
    });

    return panel;
  };

  const sidebarProvider = new TerminusSidebarWebviewProvider(bridge, workspaceRoot, () =>
    openWorkspacePanel(),
  );
  if (typeof vscodeApi.window.registerWebviewViewProvider === "function") {
    context.subscriptions.push(
      vscodeApi.window.registerWebviewViewProvider(
        TerminusSidebarWebviewProvider.viewId,
        sidebarProvider,
        { webviewOptions: { retainContextWhenHidden: true } },
      ),
    );
  }

  context.subscriptions.push(
    vscodeApi.commands.registerCommand("terminus.openWorkspace", () => openWorkspacePanel()),
    vscodeApi.commands.registerCommand("terminus.newCodingSession", async () => {
      openWorkspacePanel();
      await bridge.createSession({ workspaceRoot, mode: "orchestrate" });
    }),
    vscodeApi.commands.registerCommand("terminus.stopExecution", () => {
      const recent = bridge.listSessions(workspaceRoot)[0];
      if (recent) bridge.stopExecution(recent.sessionId);
    }),
  );

  return { bridge, openWorkspacePanel, sidebarProvider };
}

export function activate(context: VscodeExtensionContextLike): unknown {
  try {
    const req = typeof require === "function" ? require : null;
    const vscode = req ? req("vscode") : null;
    if (vscode) {
      return activateTerminusVscodeExtension(context, vscode);
    }
  } catch {}
}

export function deactivate(): void {}
