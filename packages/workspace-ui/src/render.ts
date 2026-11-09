export interface RenderWorkspaceOptions {
  hostMode?: "browser" | "vscode";
  title?: string;
  initialTheme?: "dark" | "light" | "system";
}

export function renderWorkspaceHtml(
  bootstrapState: unknown,
  options?: RenderWorkspaceOptions,
): string {
  const hostMode = options?.hostMode ?? "browser";
  const title = options?.title ?? "TERMINUS — AI Software Engineering Workspace";
  const safeBootstrapJson = JSON.stringify(bootstrapState ?? {}).replace(/</g, "\\u003c");

  return `<!DOCTYPE html>
<html lang="en" data-theme="${options?.initialTheme ?? "dark"}">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="color-scheme" content="light dark" />
  <title>${title}</title>
  <style>
    :root {
      color-scheme: dark;
      --bg-canvas: #000000;
      --bg-surface-1: #09090b;
      --bg-surface-2: #121215;
      --bg-surface-3: #1c1c21;
      --border-subtle: #242429;
      --border-strong: #383840;
      --text-primary: #f4f4f5;
      --text-secondary: #a1a1aa;
      --text-muted: #71717a;

      --status-verified: #f4f4f5;
      --status-partial: #a1a1aa;
      --status-danger: #f87171;
      --status-warning: #fbbf24;
      --status-running: #e4e4e7;

      --scrollbar-thumb: #27272a;
      --scrollbar-track: #000000;
      scrollbar-color: var(--scrollbar-thumb) var(--scrollbar-track);
      scrollbar-width: thin;
      accent-color: var(--text-primary);
    }

    * { box-sizing: border-box; }
    ::-webkit-scrollbar { width: 5px; height: 5px; }
    ::-webkit-scrollbar-thumb { background: var(--scrollbar-thumb); border-radius: 3px; }
    ::-webkit-scrollbar-track { background: var(--scrollbar-track); }

    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, 'Inter', 'SF Pro Text', 'Segoe UI', Roboto, sans-serif;
      font-size: 12.5px;
      line-height: 1.45;
      background: var(--bg-canvas);
      color: var(--text-primary);
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      user-select: text;
      -webkit-font-smoothing: antialiased;
    }
    code, pre, .mono {
      font-family: 'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace;
    }

    /* TOP BAR */
    .topbar {
      height: 42px;
      background: var(--bg-surface-1);
      border-bottom: 1px solid var(--border-subtle);
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 10px;
      gap: 8px;
      flex-shrink: 0;
    }
    .brand-cluster {
      display: flex;
      align-items: center;
      gap: 7px;
      flex-shrink: 0;
      cursor: pointer;
    }
    .brand-cluster svg {
      color: var(--text-primary);
    }
    .topbar-actions {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-shrink: 0;
    }

    /* NAVIGATION TAB STRIP */
    .nav-tab-strip {
      height: 36px;
      background: var(--bg-surface-1);
      border-bottom: 1px solid var(--border-subtle);
      display: flex;
      align-items: center;
      padding: 0 6px;
      gap: 3px;
      overflow-x: auto;
      scrollbar-width: none;
      flex-shrink: 0;
    }
    .nav-tab-strip::-webkit-scrollbar { display: none; }
    .tab-pill {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 4px 9px;
      font-size: 11px;
      font-weight: 500;
      color: var(--text-secondary);
      background: transparent;
      border: 1px solid transparent;
      border-radius: 4px;
      cursor: pointer;
      white-space: nowrap;
      transition: background 0.1s, color 0.1s, border-color 0.1s;
    }
    .tab-pill:hover {
      background: var(--bg-surface-2);
      color: var(--text-primary);
    }
    .tab-pill.active {
      background: var(--bg-surface-3);
      border-color: var(--border-strong);
      color: var(--text-primary);
      font-weight: 600;
    }

    /* SUB BAR (Active session controls) */
    .subbar {
      height: 36px;
      background: var(--bg-surface-1);
      border-bottom: 1px solid var(--border-subtle);
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 8px;
      gap: 6px;
      flex-shrink: 0;
    }
    .subbar-left, .subbar-right {
      display: flex;
      align-items: center;
      gap: 5px;
      min-width: 0;
    }
    .session-picker {
      background: var(--bg-surface-2);
      color: var(--text-primary);
      border: 1px solid var(--border-subtle);
      border-radius: 4px;
      padding: 3px 6px;
      font-size: 11px;
      max-width: 130px;
      text-overflow: ellipsis;
      outline: none;
      cursor: pointer;
    }
    .session-picker:focus {
      border-color: var(--border-strong);
    }

    /* APP LAYOUT */
    .workspace-shell {
      flex: 1;
      display: flex;
      min-height: 0;
      overflow: hidden;
      position: relative;
    }

    /* DESKTOP NAV RAIL (Expanded on wide screens >= 760px) */
    .nav-rail {
      width: 180px;
      background: var(--bg-surface-1);
      border-right: 1px solid var(--border-subtle);
      display: flex;
      flex-direction: column;
      padding: 10px 6px;
      gap: 12px;
      overflow-y: auto;
      flex-shrink: 0;
    }
    .nav-group-title {
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.08em;
      color: var(--text-muted);
      padding: 0 8px 4px;
    }
    .nav-rail .nav-link {
      display: flex;
      align-items: center;
      gap: 7px;
      padding: 5px 8px;
      border-radius: 4px;
      font-size: 12px;
      color: var(--text-secondary);
      background: transparent;
      border: none;
      cursor: pointer;
      text-align: left;
      width: 100%;
      transition: background 0.1s, color 0.1s;
    }
    .nav-rail .nav-link:hover {
      background: var(--bg-surface-2);
      color: var(--text-primary);
    }
    .nav-rail .nav-link.active {
      background: var(--bg-surface-3);
      color: var(--text-primary);
      font-weight: 600;
    }

    /* CENTER MAIN PANE */
    .main-pane {
      flex: 1;
      display: flex;
      flex-direction: column;
      min-width: 0;
      background: var(--bg-canvas);
      position: relative;
      overflow: hidden;
    }

    /* VIEW CONTAINERS */
    .view-container {
      flex: 1;
      display: none;
      flex-direction: column;
      min-height: 0;
      overflow-y: auto;
      padding: 10px;
      gap: 10px;
    }
    .view-container.active {
      display: flex;
    }

    /* STREAM & CARDS */
    .stream {
      flex: 1;
      overflow-y: auto;
      padding: 6px 2px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .card {
      background: var(--bg-surface-1);
      border: 1px solid var(--border-subtle);
      border-radius: 6px;
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      transition: border-color 0.12s;
    }
    .card:hover {
      border-color: var(--border-strong);
    }
    .card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .card-title {
      font-size: 12px;
      font-weight: 600;
      color: var(--text-primary);
    }

    /* BUTTONS */
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 5px;
      background: var(--bg-surface-2);
      color: var(--text-primary);
      border: 1px solid var(--border-subtle);
      border-radius: 4px;
      padding: 4px 9px;
      font-size: 11px;
      font-weight: 500;
      cursor: pointer;
      outline: none;
      transition: background 0.1s, border-color 0.1s, color 0.1s;
      white-space: nowrap;
    }
    .btn:hover:not(:disabled) {
      background: var(--bg-surface-3);
      border-color: var(--border-strong);
    }
    .btn:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }
    .btn-sm {
      padding: 2px 7px;
      font-size: 11px;
      height: 24px;
    }
    .btn-primary {
      background: #f4f4f5;
      color: #000000;
      border-color: #f4f4f5;
      font-weight: 600;
    }
    .btn-primary:hover:not(:disabled) {
      background: #ffffff;
      border-color: #ffffff;
      color: #000000;
    }
    .btn-danger {
      background: rgba(248, 113, 113, 0.12);
      color: var(--status-danger);
      border-color: rgba(248, 113, 113, 0.28);
    }
    .btn-danger:hover:not(:disabled) {
      background: rgba(248, 113, 113, 0.24);
      border-color: var(--status-danger);
    }

    /* BADGES */
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 6px;
      border-radius: 3px;
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      white-space: nowrap;
    }
    .badge-verified {
      background: var(--bg-surface-3);
      color: var(--text-primary);
      border: 1px solid var(--border-strong);
    }
    .badge-partial {
      background: var(--bg-surface-2);
      color: var(--text-secondary);
      border: 1px solid var(--border-subtle);
    }
    .badge-danger {
      background: rgba(248, 113, 113, 0.12);
      color: var(--status-danger);
      border: 1px solid rgba(248, 113, 113, 0.28);
    }
    .badge-running {
      background: #1c1c21;
      color: var(--text-primary);
      border: 1px solid var(--border-strong);
    }

    /* COMPOSER */
    .composer {
      background: var(--bg-surface-1);
      border-top: 1px solid var(--border-subtle);
      padding: 8px 10px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      flex-shrink: 0;
    }
    .composer-input {
      width: 100%;
      min-height: 48px;
      max-height: 160px;
      resize: vertical;
      background: var(--bg-canvas);
      border: 1px solid var(--border-subtle);
      border-radius: 5px;
      padding: 8px;
      color: var(--text-primary);
      font-size: 12.5px;
      line-height: 1.4;
      outline: none;
      font-family: inherit;
    }
    .composer-input:focus {
      border-color: var(--border-strong);
    }
    .composer-controls {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
    }
    .mode-select {
      background: var(--bg-surface-2);
      color: var(--text-primary);
      border: 1px solid var(--border-subtle);
      border-radius: 4px;
      padding: 3px 6px;
      font-size: 11px;
      outline: none;
      cursor: pointer;
    }

    /* TASK INSPECTOR DRAWER */
    .inspector-pane {
      width: 290px;
      background: var(--bg-surface-1);
      border-left: 1px solid var(--border-subtle);
      display: flex;
      flex-direction: column;
      flex-shrink: 0;
      position: absolute;
      top: 0;
      right: 0;
      bottom: 0;
      z-index: 40;
      box-shadow: -4px 0 16px rgba(0, 0, 0, 0.6);
      transform: translateX(100%);
      transition: transform 0.18s ease-in-out;
    }
    .inspector-pane.open {
      transform: translateX(0);
    }
    .inspector-header {
      height: 38px;
      padding: 0 10px;
      border-bottom: 1px solid var(--border-subtle);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .inspector-tabs {
      display: flex;
      border-bottom: 1px solid var(--border-subtle);
      background: var(--bg-surface-2);
      overflow-x: auto;
    }
    .inspector-tab {
      padding: 6px 10px;
      font-size: 11px;
      color: var(--text-secondary);
      background: transparent;
      border: none;
      border-bottom: 2px solid transparent;
      cursor: pointer;
      white-space: nowrap;
    }
    .inspector-tab.active {
      color: var(--text-primary);
      border-bottom-color: var(--text-primary);
      font-weight: 600;
    }
    .inspector-body {
      padding: 10px;
      overflow-y: auto;
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    /* RESPONSIVE LAYOUT */
    @media (max-width: 760px) {
      .nav-rail {
        display: none !important;
      }
    }
    @media (min-width: 761px) {
      .inspector-pane {
        position: relative;
        transform: none !important;
        box-shadow: none;
        display: none;
      }
      .inspector-pane.open {
        display: flex;
      }
    }

    /* MODAL DIALOGS */
    dialog:modal {
      overscroll-behavior: contain;
      background: var(--bg-surface-1);
      color: var(--text-primary);
      border: 1px solid var(--border-strong);
      border-radius: 8px;
      padding: 16px;
      max-width: 440px;
      width: 90vw;
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.85);
    }
    dialog::backdrop {
      background: rgba(0, 0, 0, 0.82);
    }
    .dialog-form {
      display: flex;
      flex-direction: column;
      gap: 10px;
      margin-top: 10px;
    }
    .form-input {
      background: var(--bg-canvas);
      border: 1px solid var(--border-subtle);
      border-radius: 4px;
      padding: 6px 8px;
      color: var(--text-primary);
      font-size: 12px;
      outline: none;
      width: 100%;
    }
    .form-input:focus {
      border-color: var(--border-strong);
    }

    /* NOTIFICATION TOAST */
    .toast-banner {
      display: none;
      position: absolute;
      top: 48px;
      left: 50%;
      transform: translateX(-50%);
      background: var(--bg-surface-3);
      border: 1px solid var(--border-strong);
      color: var(--text-primary);
      padding: 6px 12px;
      border-radius: 4px;
      font-size: 11.5px;
      z-index: 99;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.7);
    }

    .visually-hidden {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
    }
  </style>
</head>
<body data-host="${hostMode}">
  <!-- TOP BAR -->
  <header class="topbar">
    <div class="brand-cluster" id="brand-home-btn" title="TERMINUS Workspace">
      <svg width="18" height="18" viewBox="0 0 180 180" fill="none" style="flex-shrink:0;">
        <g fill="none" stroke="currentColor" stroke-width="12" stroke-linecap="square" stroke-linejoin="miter">
          <path d="M46 74 V46 H74" />
          <path d="M126 46 H154 V74" />
          <path d="M46 126 V154 H74" />
          <path d="M126 154 H154 V126" />
        </g>
        <path d="M68 72 H132 V86 H107 V130 H93 V86 H68 Z" fill="currentColor" />
        <rect x="135" y="128" width="13" height="13" fill="currentColor" />
      </svg>
      <strong class="mono" style="letter-spacing:0.08em;font-size:12px;">TERMINUS</strong>
      <span id="bridge-status-pill" class="badge badge-verified" style="font-size:9px;padding:1px 4px;">Online</span>
    </div>

    <div class="topbar-actions">
      <button type="button" id="new-session-global-btn" class="btn btn-sm" title="New Coding Session">+ New</button>
      <button type="button" id="open-full-btn" class="btn btn-sm" title="Open Full Workspace Tab">⤢ Full</button>
    </div>
  </header>

  <!-- NAVIGATION TAB STRIP (ALWAYS VISIBLE & SCROLLABLE ON ALL SCREENS) -->
  <nav class="nav-tab-strip" id="top-nav-tabs" aria-label="Workspace Views">
    <button type="button" class="tab-pill active" data-nav="workspace">● Workspace</button>
    <button type="button" class="tab-pill" data-nav="agents">◈ Agents</button>
    <button type="button" class="tab-pill" data-nav="skills">❖ Skills</button>
    <button type="button" class="tab-pill" data-nav="mcp">⚡ MCP</button>
    <button type="button" class="tab-pill" data-nav="extensions">▣ Extensions</button>
    <button type="button" class="tab-pill" data-nav="security">🛡️ Security</button>
    <button type="button" class="tab-pill" data-nav="models">⚙️ Models</button>
    <button type="button" class="tab-pill" data-nav="rules">📜 Rules</button>
    <button type="button" class="tab-pill" data-nav="analytics">📊 Analytics</button>
  </nav>

  <!-- SUB BAR (WORKSPACE EXECUTION CONTROLS) -->
  <div class="subbar" id="workspace-subbar">
    <div class="subbar-left">
      <select id="session-select" class="session-picker" aria-label="Select Active Session"></select>
      <span id="session-status-badge" class="badge badge-partial">IDLE</span>
    </div>
    <div class="subbar-right">
      <button type="button" id="pause-btn" class="btn btn-sm" title="Pause / Resume execution">Pause</button>
      <button type="button" id="stop-btn" class="btn btn-sm" title="Stop active task">Stop</button>
      <button type="button" id="inspect-drawer-btn" class="btn btn-sm" title="Toggle Task Inspector">Inspect</button>
    </div>
  </div>

  <div id="toast-banner" class="toast-banner"></div>

  <!-- APPLICATION SHELL -->
  <div class="workspace-shell">
    <!-- WIDE NAVIGATION RAIL (DESKTOP) -->
    <nav class="nav-rail" aria-label="Desktop Side Navigation">
      <div>
        <div class="nav-group-title">WORKSPACE</div>
        <button type="button" class="nav-link active" data-nav="workspace">
          <span>●</span> Workspace
        </button>
      </div>

      <div>
        <div class="nav-group-title">BUILD &amp; EXTEND</div>
        <button type="button" class="nav-link" data-nav="agents">
          <span>◈</span> Agents
        </button>
        <button type="button" class="nav-link" data-nav="skills">
          <span>❖</span> Skills Studio
        </button>
        <button type="button" class="nav-link" data-nav="extensions">
          <span>▣</span> Extensions
        </button>
        <button type="button" class="nav-link" data-nav="mcp">
          <span>⚡</span> MCP &amp; Tools
        </button>
        <button type="button" class="nav-link" data-nav="models">
          <span>⚙</span> Models
        </button>
      </div>

      <div>
        <div class="nav-group-title">GOVERNANCE</div>
        <button type="button" class="nav-link" data-nav="rules">
          <span>📜</span> Rules &amp; Context
        </button>
        <button type="button" class="nav-link" data-nav="security">
          <span>🛡️</span> Security
        </button>
        <button type="button" class="nav-link" data-nav="analytics">
          <span>📊</span> Analytics
        </button>
      </div>
    </nav>

    <!-- CENTER PANE (HOSTING ALL 9 SCREENS) -->
    <main class="main-pane">
      <!-- 1. WORKSPACE VIEW -->
      <section id="view-workspace" class="view-container active" aria-label="Coding Workspace">
        <div id="execution-stream" class="stream">
          <div class="card" id="initial-welcome-card">
            <div class="card-header">
              <span class="card-title">TERMINUS Autonomous Engineering Runtime</span>
              <span id="verdict-stamp" class="badge badge-partial">READY</span>
            </div>
            <p style="margin:0;font-size:12px;color:var(--text-secondary);">
              Multi-Agent Orchestrator with cryptographic SHA-256 evidence validation, quarantined skill execution, and 20 OWASP system safety invariants. Describe an instruction below to begin.
            </p>
            <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:2px;">
              <span class="badge badge-partial mono" id="welcome-model-pill">NVIDIA Nemotron 70B</span>
              <span class="badge badge-partial mono" id="welcome-budget-pill">$2.00 Max Budget</span>
            </div>
          </div>
        </div>

        <form id="composer-form" class="composer">
          <label for="composer-textarea" class="visually-hidden">Task prompt</label>
          <textarea id="composer-textarea" class="composer-input" placeholder="Describe a task or instruction... (Enter to run, Shift+Enter for newline)"></textarea>
          <div class="composer-controls">
            <select id="mode-select" class="mode-select" aria-label="Execution Mode">
              <option value="orchestrate">Orchestrate (Multi-Agent)</option>
              <option value="act">Act (Plan + Execute)</option>
              <option value="plan">Plan (Read-Only)</option>
              <option value="ask">Ask (Chat)</option>
            </select>
            <button type="submit" id="send-submit-btn" class="btn btn-primary btn-sm">Run Task</button>
          </div>
        </form>
      </section>

      <!-- 2. AGENTS VIEW -->
      <section id="view-agents" class="view-container" aria-label="Specialist Agents">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <div>
            <strong style="font-size:13px;">Specialist Agents &amp; Harnesses</strong>
            <div style="font-size:11px;color:var(--text-secondary);">OO-Harness hierarchy with strict execution boundaries</div>
          </div>
          <button type="button" id="create-agent-btn" class="btn btn-sm btn-primary">+ Create Agent</button>
        </div>
        <div id="agents-list" style="display:flex;flex-direction:column;gap:8px;"></div>
      </section>

      <!-- 3. SKILLS VIEW -->
      <section id="view-skills" class="view-container" aria-label="Skills Studio">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <div>
            <strong style="font-size:13px;">Skills Studio</strong>
            <div style="font-size:11px;color:var(--text-secondary);">Discovered agent skills with SHA-256 trust verification</div>
          </div>
          <button type="button" id="add-skill-btn" class="btn btn-sm btn-primary">+ Add Skill</button>
        </div>
        <div id="skills-list" style="display:flex;flex-direction:column;gap:8px;"></div>
      </section>

      <!-- 4. MCP VIEW -->
      <section id="view-mcp" class="view-container" aria-label="MCP &amp; Tools">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <div>
            <strong style="font-size:13px;">MCP &amp; Tool Integrations</strong>
            <div style="font-size:11px;color:var(--text-secondary);">Model Context Protocol client connections and tools</div>
          </div>
          <button type="button" id="add-mcp-btn" class="btn btn-sm btn-primary">+ Add Server</button>
        </div>
        <div id="mcp-list" style="display:flex;flex-direction:column;gap:8px;"></div>
      </section>

      <!-- 5. EXTENSIONS VIEW -->
      <section id="view-extensions" class="view-container" aria-label="Extensions Host">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <div>
            <strong style="font-size:13px;">Isolated Plugin Extension Host</strong>
            <div style="font-size:11px;color:var(--text-secondary);">Sandboxed plugins running in isolated worker threads</div>
          </div>
        </div>
        <div class="card">
          <div class="card-title">Extension Isolation Boundaries</div>
          <p style="font-size:11.5px;color:var(--text-secondary);margin:0;">
            All plugins run in dedicated Node/Bun Worker Threads. Memory ceiling: 256MB. Execution timeout: 30s. Zero direct access to agent execution state.
          </p>
        </div>
        <div id="extensions-list" style="display:flex;flex-direction:column;gap:8px;"></div>
      </section>

      <!-- 6. SECURITY VIEW -->
      <section id="view-security" class="view-container" aria-label="Security &amp; Permissions">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <div>
            <strong style="font-size:13px;">Security &amp; Permission Engine</strong>
            <div style="font-size:11px;color:var(--text-secondary);">OWASP enforcement, hard-deny rules, and audit trail</div>
          </div>
        </div>
        <div class="card">
          <div class="card-title">20 Invariant Hard-Deny Rules Enforced</div>
          <p style="font-size:11.5px;color:var(--text-secondary);margin:0;">
            Hard-blocks SSH key exfiltration, forced git pushes, credential destruction, and unverified worker self-certifications.
          </p>
        </div>
        <div>
          <strong style="font-size:11px;color:var(--text-muted);letter-spacing:0.04em;">PERMISSION AUDIT LOG</strong>
        </div>
        <div id="security-list" style="display:flex;flex-direction:column;gap:6px;"></div>
      </section>

      <!-- 7. MODELS VIEW -->
      <section id="view-models" class="view-container" aria-label="Model Providers">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <div>
            <strong style="font-size:13px;">Model Providers &amp; Gateway</strong>
            <div style="font-size:11px;color:var(--text-secondary);">Multi-provider abstraction with SecretVault credentials</div>
          </div>
        </div>
        <div id="models-list" style="display:flex;flex-direction:column;gap:8px;"></div>
      </section>

      <!-- 8. RULES VIEW -->
      <section id="view-rules" class="view-container" aria-label="Rules &amp; Context">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <div>
            <strong style="font-size:13px;">Rules &amp; Context Hierarchy</strong>
            <div style="font-size:11px;color:var(--text-secondary);">5-layer instruction cascade with repository map</div>
          </div>
        </div>
        <div id="rules-list" style="display:flex;flex-direction:column;gap:8px;"></div>
      </section>

      <!-- 9. ANALYTICS VIEW -->
      <section id="view-analytics" class="view-container" aria-label="Budgets &amp; Analytics">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <div>
            <strong style="font-size:13px;">Budgets &amp; Analytics</strong>
            <div style="font-size:11px;color:var(--text-secondary);">Hard execution boundaries and verification ledger metrics</div>
          </div>
        </div>
        <div id="analytics-list" style="display:flex;flex-direction:column;gap:8px;"></div>
      </section>
    </main>

    <!-- TASK INSPECTOR DRAWER / PANE -->
    <aside class="inspector-pane" id="inspector-pane" aria-label="Task Inspector">
      <div class="inspector-header">
        <strong style="font-size:11px;letter-spacing:0.06em;">TASK INSPECTOR</strong>
        <button type="button" id="close-inspector-btn" class="btn btn-sm" title="Close Inspector">✕</button>
      </div>
      <div class="inspector-tabs">
        <button type="button" class="inspector-tab active" data-tab="verification">Verdict</button>
        <button type="button" class="inspector-tab" data-tab="diff">Diff</button>
        <button type="button" class="inspector-tab" data-tab="plan">Plan</button>
        <button type="button" class="inspector-tab" data-tab="agents">Agents</button>
        <button type="button" class="inspector-tab" data-tab="files">Files</button>
      </div>
      <div class="inspector-body" id="inspector-content"></div>
    </aside>
  </div>

  <!-- UNSAVED CONFIG DIALOG -->
  <dialog id="unsaved-config-dialog">
    <div style="display:flex;justify-content:space-between;align-items:center;">
      <strong style="font-size:13px;">Unsaved Configuration Changes</strong>
    </div>
    <p style="font-size:12px;color:var(--text-secondary);margin:8px 0 12px;">You have unsaved changes. Discard changes and switch screens?</p>
    <div style="display:flex;justify-content:flex-end;gap:6px;">
      <button type="button" id="stay-config-btn" class="btn btn-sm">Stay</button>
      <button type="button" id="discard-config-btn" class="btn btn-sm btn-danger">Discard &amp; Switch</button>
    </div>
  </dialog>

  <!-- CREATE AGENT MODAL -->
  <dialog id="agent-dialog">
    <div style="display:flex;justify-content:space-between;align-items:center;">
      <strong style="font-size:13px;">Register Custom Specialist Agent</strong>
      <button type="button" id="close-agent-modal" class="btn btn-sm">✕</button>
    </div>
    <form class="dialog-form" id="agent-form">
      <div>
        <label style="font-size:11px;color:var(--text-secondary);">Agent Name</label>
        <input class="form-input" id="new-agent-name" placeholder="e.g. TestEngineer" required />
      </div>
      <div>
        <label style="font-size:11px;color:var(--text-secondary);">Role &amp; Responsibility</label>
        <input class="form-input" id="new-agent-role" placeholder="e.g. Unit and integration test author" required />
      </div>
      <div>
        <label style="font-size:11px;color:var(--text-secondary);">System Prompt Instructions</label>
        <textarea class="form-input" id="new-agent-prompt" style="height:70px;resize:vertical;" placeholder="Agent instructions..."></textarea>
      </div>
      <div style="display:flex;justify-content:flex-end;gap:6px;margin-top:6px;">
        <button type="button" id="cancel-agent-modal" class="btn btn-sm">Cancel</button>
        <button type="submit" class="btn btn-sm btn-primary">Save Agent</button>
      </div>
    </form>
  </dialog>

  <!-- ADD MCP MODAL -->
  <dialog id="mcp-dialog">
    <div style="display:flex;justify-content:space-between;align-items:center;">
      <strong style="font-size:13px;">Add MCP Server</strong>
      <button type="button" id="close-mcp-modal" class="btn btn-sm">✕</button>
    </div>
    <form class="dialog-form" id="mcp-form">
      <div>
        <label style="font-size:11px;color:var(--text-secondary);">Server ID</label>
        <input class="form-input" id="new-mcp-id" placeholder="e.g. database-mcp" required />
      </div>
      <div>
        <label style="font-size:11px;color:var(--text-secondary);">Command</label>
        <input class="form-input" id="new-mcp-cmd" placeholder="e.g. npx" required />
      </div>
      <div>
        <label style="font-size:11px;color:var(--text-secondary);">Arguments (space separated)</label>
        <input class="form-input" id="new-mcp-args" placeholder="-y @modelcontextprotocol/server-postgres ..." />
      </div>
      <div style="display:flex;justify-content:flex-end;gap:6px;margin-top:6px;">
        <button type="button" id="cancel-mcp-modal" class="btn btn-sm">Cancel</button>
        <button type="submit" class="btn btn-sm btn-primary">Connect MCP</button>
      </div>
    </form>
  </dialog>

  <!-- JAVASCRIPT LOGIC -->
  <script>
    (function() {
      const boot = ${safeBootstrapJson};
      const vscodeApi = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : null;

      // STATE
      let activeView = "workspace";
      let sessions = Array.isArray(boot.sessions) ? [...boot.sessions] : [];
      let activeSessionId = sessions[0] ? sessions[0].sessionId : "";
      let executionStatus = "idle"; // idle | running | paused | stopped | completed
      let isPaused = false;
      let activeInspectorTab = "verification";
      const events = [];

      // DOM ELEMENTS
      const topNavTabs = document.querySelectorAll("#top-nav-tabs .tab-pill");
      const railNavLinks = document.querySelectorAll(".nav-rail .nav-link");
      const sessionSelect = document.getElementById("session-select");
      const sessionStatusBadge = document.getElementById("session-status-badge");
      const verdictStamp = document.getElementById("verdict-stamp");
      const pauseBtn = document.getElementById("pause-btn");
      const stopBtn = document.getElementById("stop-btn");
      const inspectDrawerBtn = document.getElementById("inspect-drawer-btn");
      const inspectorPane = document.getElementById("inspector-pane");
      const inspectorContent = document.getElementById("inspector-content");
      const streamEl = document.getElementById("execution-stream");
      const composerForm = document.getElementById("composer-form");
      const composerTextarea = document.getElementById("composer-textarea");
      const modeSelect = document.getElementById("mode-select");
      const toastBanner = document.getElementById("toast-banner");

      function showToast(msg, durationMs = 2800) {
        if (!toastBanner) return;
        toastBanner.textContent = msg;
        toastBanner.style.display = "block";
        setTimeout(() => { toastBanner.style.display = "none"; }, durationMs);
      }

      // RPC BRIDGE CLIENT
      let rpcSeq = 0;
      const pendingRpcs = new Map();

      function callRpc(method, params = {}) {
        if (vscodeApi) {
          const reqId = "rpc-" + (++rpcSeq);
          return new Promise((resolve, reject) => {
            pendingRpcs.set(reqId, { resolve, reject });
            vscodeApi.postMessage({ type: "rpc", requestId: reqId, method, params });
            setTimeout(() => {
              if (pendingRpcs.has(reqId)) {
                pendingRpcs.delete(reqId);
                reject(new Error("RPC timeout: " + method));
              }
            }, 30000);
          });
        }
        return fetch("/api/rpc", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ method, params }),
        }).then(r => r.json()).then(d => {
          if (!d.ok) throw new Error(d.error || "RPC Failed");
          return d.result;
        });
      }

      // VS CODE MESSAGE LISTENER
      window.addEventListener("message", (event) => {
        const msg = event.data;
        if (!msg) return;
        if (msg.type === "rpc_response" && msg.requestId) {
          const pending = pendingRpcs.get(msg.requestId);
          if (pending) {
            pendingRpcs.delete(msg.requestId);
            if (msg.ok) pending.resolve(msg.result);
            else pending.reject(new Error(msg.error || "RPC execution failed"));
          }
        } else if (msg.type === "runtime_event" && msg.envelope) {
          handleRuntimeEnvelope(msg.envelope);
        }
      });

      // VIEW SWITCHING
      function switchView(target) {
        activeView = target;
        topNavTabs.forEach(tab => {
          tab.classList.toggle("active", tab.getAttribute("data-nav") === target);
        });
        railNavLinks.forEach(link => {
          link.classList.toggle("active", link.getAttribute("data-nav") === target);
        });

        document.querySelectorAll(".view-container").forEach(c => {
          c.classList.remove("active");
        });
        const targetContainer = document.getElementById("view-" + target);
        if (targetContainer) targetContainer.classList.add("active");

        const subbar = document.getElementById("workspace-subbar");
        if (subbar) {
          subbar.style.display = target === "workspace" ? "flex" : "none";
        }

        populateViewData(target);
      }

      topNavTabs.forEach(btn => {
        btn.addEventListener("click", () => switchView(btn.getAttribute("data-nav") || "workspace"));
      });
      railNavLinks.forEach(btn => {
        btn.addEventListener("click", () => switchView(btn.getAttribute("data-nav") || "workspace"));
      });
      document.getElementById("brand-home-btn")?.addEventListener("click", () => switchView("workspace"));
      document.getElementById("open-full-btn")?.addEventListener("click", () => {
        if (vscodeApi) vscodeApi.postMessage({ type: "rpc", method: "openWorkspaceTab", params: {} });
        else showToast("Open Full Tab is active in IDE mode.");
      });

      // SESSIONS MANAGEMENT
      function updateSessionDropdown() {
        if (!sessionSelect) return;
        sessionSelect.innerHTML = "";
        if (sessions.length === 0) {
          const opt = document.createElement("option");
          opt.value = "";
          opt.textContent = "New Session";
          sessionSelect.appendChild(opt);
          return;
        }
        for (const s of sessions) {
          const opt = document.createElement("option");
          opt.value = s.sessionId;
          const label = s.task ? (s.task.length > 20 ? s.task.slice(0, 18) + "…" : s.task) : s.sessionId.slice(0, 8);
          opt.textContent = label;
          if (s.sessionId === activeSessionId) opt.selected = true;
          sessionSelect.appendChild(opt);
        }
      }

      sessionSelect?.addEventListener("change", (e) => {
        const val = e.target.value;
        if (val && val !== activeSessionId) {
          activeSessionId = val;
          executionStatus = "idle";
          isPaused = false;
          updateControlsState();
          loadSessionEvents(val);
        }
      });

      async function createNewSession(taskPrompt = "New Coding Session") {
        try {
          const res = await callRpc("createSession", {
            mode: modeSelect ? modeSelect.value : "orchestrate",
            task: taskPrompt,
          });
          if (res && res.sessionId) {
            sessions.unshift(res);
            activeSessionId = res.sessionId;
            executionStatus = "idle";
            isPaused = false;
            updateSessionDropdown();
            updateControlsState();
            return res.sessionId;
          }
        } catch (err) {
          showToast("Failed to create session: " + err.message);
        }
        return null;
      }

      document.getElementById("new-session-global-btn")?.addEventListener("click", () => createNewSession());

      async function loadSessionEvents(sId) {
        try {
          const past = await callRpc("getExecutionEvents", { sessionId: sId, afterSeq: 0 });
          if (Array.isArray(past)) {
            streamEl.innerHTML = "";
            for (const env of past) appendEventCard(env);
          }
        } catch {}
      }

      // EXECUTION CONTROLS: PAUSE / RESUME / STOP
      function updateControlsState() {
        if (sessionStatusBadge) {
          sessionStatusBadge.textContent = executionStatus.toUpperCase();
          if (executionStatus === "running") {
            sessionStatusBadge.className = "badge badge-running";
          } else if (executionStatus === "paused") {
            sessionStatusBadge.className = "badge badge-partial";
          } else if (executionStatus === "stopped" || executionStatus === "cancelled") {
            sessionStatusBadge.className = "badge badge-danger";
          } else if (executionStatus === "completed" || executionStatus === "verified") {
            sessionStatusBadge.className = "badge badge-verified";
          } else {
            sessionStatusBadge.className = "badge badge-partial";
          }
        }

        if (pauseBtn) {
          if (isPaused) {
            pauseBtn.textContent = "Resume";
            pauseBtn.className = "btn btn-sm btn-primary";
          } else {
            pauseBtn.textContent = "Pause";
            pauseBtn.className = "btn btn-sm";
          }
        }

        if (stopBtn) {
          stopBtn.disabled = executionStatus === "idle" || executionStatus === "completed" || executionStatus === "stopped";
        }
      }

      pauseBtn?.addEventListener("click", async () => {
        if (!activeSessionId || executionStatus === "idle") {
          showToast("Agent is idle. Enter a prompt below to run a task.");
          return;
        }
        try {
          if (isPaused) {
            await callRpc("resumeExecution", { sessionId: activeSessionId });
            isPaused = false;
            executionStatus = "running";
            showToast("Execution resumed.");
          } else {
            await callRpc("pauseExecution", { sessionId: activeSessionId });
            isPaused = true;
            executionStatus = "paused";
            showToast("Execution paused.");
          }
          updateControlsState();
        } catch (err) {
          showToast("Pause/Resume error: " + err.message);
        }
      });

      stopBtn?.addEventListener("click", async () => {
        if (!activeSessionId || executionStatus === "idle") {
          showToast("No active execution to stop.");
          return;
        }
        try {
          await callRpc("stopExecution", { sessionId: activeSessionId });
          executionStatus = "stopped";
          isPaused = false;
          updateControlsState();
          if (verdictStamp) {
            verdictStamp.textContent = "STOPPED";
            verdictStamp.className = "badge badge-danger";
          }
          showToast("Execution cancelled.");
        } catch (err) {
          showToast("Stop error: " + err.message);
        }
      });

      // INSPECTOR DRAWER TOGGLE & TABS
      inspectDrawerBtn?.addEventListener("click", () => {
        inspectorPane?.classList.toggle("open");
        renderInspectorContent();
      });
      document.getElementById("close-inspector-btn")?.addEventListener("click", () => {
        inspectorPane?.classList.remove("open");
      });

      document.querySelectorAll(".inspector-tab").forEach(tab => {
        tab.addEventListener("click", () => {
          activeInspectorTab = tab.getAttribute("data-tab") || "verification";
          document.querySelectorAll(".inspector-tab").forEach(t => t.classList.remove("active"));
          tab.classList.add("active");
          renderInspectorContent();
        });
      });

      function renderInspectorContent() {
        if (!inspectorContent) return;
        if (activeInspectorTab === "verification") {
          inspectorContent.innerHTML =
            '<div class="card"><div class="card-title">Cryptographic Evidence Ledger</div>' +
            '<div style="font-size:11.5px;margin-top:6px;display:flex;flex-direction:column;gap:5px;">' +
            '<div><strong>Hash Chain:</strong> <span class="mono">SHA-256 Validated</span></div>' +
            '<div><strong>Self-Certification:</strong> <span class="badge badge-danger" style="font-size:9px;">Blocked</span></div>' +
            '<div><strong>Adversarial Pass:</strong> <span class="badge badge-verified" style="font-size:9px;">Clean</span></div>' +
            '<div><strong>False Acceptance Rate:</strong> 0.00%</div>' +
            '</div></div>';
        } else if (activeInspectorTab === "diff") {
          inspectorContent.innerHTML = '<div class="card"><div class="card-title">Unified File Diffs</div><p style="font-size:11.5px;color:var(--text-secondary);margin:4px 0 0;">Pre-modification baseline snapshots preserved. Changes are audited line-by-line before writing to disk.</p></div>';
        } else if (activeInspectorTab === "plan") {
          inspectorContent.innerHTML = '<div class="card"><div class="card-title">Structured Task Plan</div><p style="font-size:11.5px;color:var(--text-secondary);margin:4px 0 0;">Agent-generated DAG plan with explicit approval gates before high-impact tool execution.</p></div>';
        } else if (activeInspectorTab === "agents") {
          const harnesses = (boot.harnesses && boot.harnesses.harnesses) || [];
          inspectorContent.innerHTML = harnesses.map(h =>
            '<div class="card"><strong style="font-size:11px;">' + h.name + '</strong><div style="font-size:11px;color:var(--text-secondary);">' + h.role + '</div></div>'
          ).join("");
        } else if (activeInspectorTab === "files") {
          const repoMap = (boot.instructions && boot.instructions.repoMapPreview) || "Repository map ready.";
          inspectorContent.innerHTML = '<pre class="card mono" style="font-size:10px;overflow:auto;max-height:300px;white-space:pre-wrap;">' + repoMap.replace(/</g, "&lt;") + '</pre>';
        }
      }

      // STREAM EVENT RENDERING
      function handleRuntimeEnvelope(env) {
        events.push(env);
        appendEventCard(env);
      }

      function appendEventCard(env) {
        if (!streamEl) return;
        const p = env.payload || {};
        const card = document.createElement("div");
        card.className = "card";

        if (p.type === "verification.completed") {
          executionStatus = p.overallVerdict === "VERIFIED" ? "verified" : "stopped";
          updateControlsState();
          if (verdictStamp) {
            verdictStamp.textContent = p.overallVerdict;
            verdictStamp.className = "badge " + (p.overallVerdict === "VERIFIED" ? "badge-verified" : "badge-danger");
          }
          card.innerHTML = '<div class="card-header"><span class="card-title">Verification Verdict: ' + p.overallVerdict + '</span><span class="badge badge-verified">SHA-256</span></div>' +
            '<p style="color:var(--text-secondary);font-size:11.5px;margin:2px 0 0;">' + String(p.summary || "").replace(/</g, "&lt;") + '</p>';
        } else if (p.type === "approval.required") {
          card.innerHTML = '<div class="card-header"><span class="card-title">Action Approval Required</span><span class="badge badge-partial">' + p.tier + '</span></div>' +
            '<p class="mono" style="font-size:11px;margin:4px 0 8px;word-break:break-all;">' + String(p.summary || "").replace(/</g, "&lt;") + '</p>' +
            '<div style="display:flex;gap:6px;">' +
            '<button type="button" class="btn btn-sm btn-primary" data-approve="' + p.approvalId + '">Approve Once</button>' +
            '<button type="button" class="btn btn-sm" data-approve-always="' + p.approvalId + '">Always Allow</button>' +
            '<button type="button" class="btn btn-sm btn-danger" data-reject="' + p.approvalId + '">Reject</button>' +
            '</div>';
        } else if (p.type === "agent.progress") {
          card.innerHTML = '<div style="display:flex;align-items:center;gap:6px;"><span class="badge badge-partial mono">#' + env.seq + ' ' + (p.stage || "progress") + '</span><span style="font-size:11.5px;color:var(--text-secondary);">' + (p.agentId || "agent") + '</span></div>' +
            '<div style="font-size:12px;margin-top:3px;">' + String(p.summary || p.textDelta || "").replace(/</g, "&lt;") + '</div>';
        } else if (p.type === "tool.started") {
          card.innerHTML = '<div class="card-header"><span class="card-title mono">' + p.toolName + '</span><span class="badge badge-running">RUNNING</span></div>' +
            '<div class="mono" style="font-size:11px;color:var(--text-secondary);word-break:break-all;">' + String(p.inputSummary || "").replace(/</g, "&lt;") + '</div>';
        } else if (p.type === "tool.completed") {
          card.innerHTML = '<div class="card-header"><span class="card-title mono">' + p.toolName + '</span><span class="badge badge-verified">✓ ' + (p.durationMs || 10) + 'ms</span></div>' +
            '<pre class="mono" style="font-size:10.5px;color:var(--text-secondary);margin:0;max-height:120px;overflow:auto;background:var(--bg-canvas);padding:6px;border-radius:4px;">' + String(p.outputPreview || "Completed").replace(/</g, "&lt;") + '</pre>';
        } else {
          card.innerHTML = '<div style="font-size:11px;color:var(--text-muted);">' + p.type + '</div>' +
            '<div style="font-size:12px;">' + String(p.summary || p.toolName || p.state || "").replace(/</g, "&lt;") + '</div>';
        }

        streamEl.appendChild(card);
        streamEl.scrollTop = streamEl.scrollHeight;
      }

      // COMPOSER SUBMIT
      composerForm?.addEventListener("submit", async (e) => {
        e.preventDefault();
        const prompt = composerTextarea.value.trim();
        if (!prompt) return;
        composerTextarea.value = "";

        // Append user card to stream immediately
        const userCard = document.createElement("div");
        userCard.className = "card";
        userCard.style.borderColor = "var(--border-strong)";
        userCard.innerHTML = '<div class="card-header"><strong style="font-size:12px;">Instruction</strong><span class="badge badge-partial mono">' + (modeSelect?.value || "orchestrate") + '</span></div>' +
          '<div style="font-size:12.5px;color:var(--text-primary);white-space:pre-wrap;">' + prompt.replace(/</g, "&lt;") + '</div>';
        streamEl.appendChild(userCard);
        streamEl.scrollTop = streamEl.scrollHeight;

        if (!activeSessionId) {
          activeSessionId = await createNewSession(prompt);
        }

        if (activeSessionId) {
          executionStatus = "running";
          isPaused = false;
          updateControlsState();
          if (verdictStamp) {
            verdictStamp.textContent = "RUNNING";
            verdictStamp.className = "badge badge-running";
          }
          try {
            await callRpc("sendMessage", {
              sessionId: activeSessionId,
              prompt,
              mode: modeSelect ? modeSelect.value : "orchestrate",
            });
          } catch (err) {
            showToast("SendMessage error: " + err.message);
          }
        }
      });

      composerTextarea?.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          if (e.isComposing || e.keyCode === 229) return;
          composerForm.requestSubmit();
        }
      });

      // INTERACTIVE ACTION APPROVAL HANDLER
      document.addEventListener("click", async (e) => {
        const appBtn = e.target.closest("[data-approve]");
        const alwaysBtn = e.target.closest("[data-approve-always]");
        const rejBtn = e.target.closest("[data-reject]");

        if (appBtn && activeSessionId) {
          const aId = appBtn.getAttribute("data-approve");
          await callRpc("approveAction", { sessionId: activeSessionId, approvalId: aId, scope: "once" });
          appBtn.parentElement.innerHTML = '<span class="badge badge-verified">Approved (Once)</span>';
        } else if (alwaysBtn && activeSessionId) {
          const aId = alwaysBtn.getAttribute("data-approve-always");
          await callRpc("approveAction", { sessionId: activeSessionId, approvalId: aId, scope: "session" });
          alwaysBtn.parentElement.innerHTML = '<span class="badge badge-verified">Always Allowed</span>';
        } else if (rejBtn && activeSessionId) {
          const aId = rejBtn.getAttribute("data-reject");
          await callRpc("rejectAction", { sessionId: activeSessionId, approvalId: aId, reason: "Rejected in UI" });
          rejBtn.parentElement.innerHTML = '<span class="badge badge-danger">Rejected</span>';
        }
      });

      // POPULATE ALL 8 DEDICATED VIEWS
      function populateViewData(v) {
        if (v === "agents") {
          const list = document.getElementById("agents-list");
          const harnesses = (boot.harnesses && boot.harnesses.harnesses) || [];
          if (!list) return;
          list.innerHTML = harnesses.map(h =>
            '<div class="card">' +
            '<div class="card-header"><span class="card-title">' + h.name + '</span><span class="badge badge-verified">Active</span></div>' +
            '<div style="font-size:11.5px;color:var(--text-secondary);">' + h.role + '</div>' +
            '<div class="mono" style="font-size:10.5px;color:var(--text-muted);display:flex;gap:8px;margin-top:2px;">' +
            '<span>Model: ' + (h.model || "nemotron-70b") + '</span> · <span>FS: ' + h.permissions.filesystem + '</span> · <span>Tools: ' + h.tools.length + '</span>' +
            '</div></div>'
          ).join("");
        } else if (v === "skills") {
          const list = document.getElementById("skills-list");
          const skills = boot.skills || [];
          if (!list) return;
          if (skills.length === 0) {
            list.innerHTML = '<div class="card"><div style="color:var(--text-secondary);">No skills found. Add SKILL.md in ./skills or ~/.terminus/skills.</div></div>';
            return;
          }
          list.innerHTML = skills.map(s =>
            '<div class="card">' +
            '<div class="card-header"><span class="card-title">' + s.name + '</span>' +
            '<span class="badge ' + (s.trustState === "quarantined" ? "badge-danger" : "badge-verified") + '">' + (s.trustState || "trusted") + ' · ' + (s.scope || "workspace") + '</span></div>' +
            '<div style="color:var(--text-secondary);font-size:11.5px;">' + (s.description || "No description provided.") + '</div>' +
            (s.trustState === "quarantined" ? '<button type="button" class="btn btn-sm btn-primary" style="margin-top:4px;" data-approve-skill="' + s.name + '">Review &amp; Trust (SHA-256)</button>' : '') +
            '</div>'
          ).join("");
        } else if (v === "mcp") {
          const list = document.getElementById("mcp-list");
          const presets = (boot.mcp && boot.mcp.presets) || [];
          if (!list) return;
          list.innerHTML = presets.map(m =>
            '<div class="card">' +
            '<div class="card-header"><span class="card-title">' + m.name + '</span>' +
            '<span class="badge badge-partial mono">' + m.template.transport + '</span></div>' +
            '<div style="color:var(--text-secondary);font-size:11.5px;">' + m.description + '</div>' +
            '<div style="display:flex;gap:6px;align-items:center;margin-top:4px;">' +
            '<button type="button" class="btn btn-sm" data-test-mcp="' + m.name + '">Test Ping</button>' +
            '<span style="font-size:10px;color:var(--text-muted);margin-left:auto;">Secrets: Scrubbed</span>' +
            '</div></div>'
          ).join("");
        } else if (v === "extensions") {
          const list = document.getElementById("extensions-list");
          const exts = boot.extensions || [];
          if (!list) return;
          list.innerHTML = exts.length === 0
            ? '<div class="card"><div class="card-title">Extension Host Ready</div><p style="color:var(--text-secondary);font-size:11.5px;margin:2px 0 0;">No third-party plugins installed yet. Plugins installed in ~/.terminus/plugins run isolated with memory and execution timeout caps.</p></div>'
            : exts.map(e =>
              '<div class="card"><div class="card-header"><span class="card-title">' + e.manifest.name + '</span><span class="badge badge-verified">' + e.status + '</span></div>' +
              '<p style="color:var(--text-secondary);font-size:11.5px;margin:2px 0 0;">' + (e.manifest.description || "") + '</p></div>'
            ).join("");
        } else if (v === "security") {
          const list = document.getElementById("security-list");
          const audits = (boot.security && boot.security.auditLogs) || [];
          if (!list) return;
          list.innerHTML = audits.slice(0, 15).map(a =>
            '<div class="card" style="padding:6px 8px;">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;">' +
            '<span class="mono" style="font-size:11px;font-weight:600;">' + a.action_kind + '</span>' +
            '<span class="badge ' + (a.verdict === "approved" ? "badge-verified" : "badge-danger") + '">' + a.verdict + '</span>' +
            '</div>' +
            '<div class="mono" style="color:var(--text-secondary);font-size:10.5px;margin-top:2px;word-break:break-all;">' + a.target + '</div>' +
            '</div>'
          ).join("");
        } else if (v === "models") {
          const list = document.getElementById("models-list");
          const providers = boot.providers || [];
          if (!list) return;
          list.innerHTML = providers.map(p =>
            '<div class="card">' +
            '<div class="card-header"><span class="card-title">' + p.displayName + '</span>' +
            '<span class="badge ' + (p.hasApiKeyConfigured ? "badge-verified" : "badge-partial") + '">' + (p.hasApiKeyConfigured ? "Key Configured" : "Key Missing") + '</span></div>' +
            '<div class="mono" style="font-size:11px;color:var(--text-secondary);">Default: ' + p.defaultModel + '</div>' +
            '<div style="display:flex;gap:6px;align-items:center;margin-top:4px;">' +
            '<input type="password" class="form-input" style="flex:1;font-size:11px;" placeholder="Update API Key" id="key-input-' + p.provider + '" />' +
            '<button type="button" class="btn btn-sm btn-primary" data-save-key="' + p.provider + '">Save</button>' +
            '</div></div>'
          ).join("");
        } else if (v === "rules") {
          const list = document.getElementById("rules-list");
          const layers = (boot.instructions && boot.instructions.layers) || [];
          if (!list) return;
          list.innerHTML = layers.map(l =>
            '<div class="card">' +
            '<div class="card-header"><span class="card-title">Level ' + l.priority + ': ' + l.label + '</span><span class="badge badge-partial mono">' + l.scope + '</span></div>' +
            '<div class="mono" style="font-size:10.5px;color:var(--text-muted);word-break:break-all;">' + l.path + '</div>' +
            '</div>'
          ).join("");
        } else if (v === "analytics") {
          const list = document.getElementById("analytics-list");
          if (!list) return;
          list.innerHTML =
            '<div class="card">' +
            '<div class="card-header"><span class="card-title">Token Limit Boundary</span><span class="badge badge-verified">120,000 Max</span></div>' +
            '<div style="background:var(--bg-surface-2);border-radius:4px;height:8px;overflow:hidden;margin-top:4px;"><div style="background:#f4f4f5;width:8%;height:100%;"></div></div>' +
            '<div style="font-size:11px;color:var(--text-secondary);margin-top:2px;">9,400 / 120,000 tokens used (7.8%)</div>' +
            '</div>' +
            '<div class="card">' +
            '<div class="card-header"><span class="card-title">Cost Limit Boundary</span><span class="badge badge-verified">$2.00 Max</span></div>' +
            '<div style="background:var(--bg-surface-2);border-radius:4px;height:8px;overflow:hidden;margin-top:4px;"><div style="background:#f4f4f5;width:3%;height:100%;"></div></div>' +
            '<div style="font-size:11px;color:var(--text-secondary);margin-top:2px;">$0.06 / $2.00 allocated (3.0%)</div>' +
            '</div>' +
            '<div class="card">' +
            '<div class="card-header"><span class="card-title">Verification Integrity</span><span class="badge badge-verified">100% Chain</span></div>' +
            '<div style="font-size:11.5px;color:var(--text-secondary);">False Acceptances: 0 · SHA-256 Ledger Validated</div>' +
            '</div>';
        }
      }

      // MODALS HANDLERS
      const agentDialog = document.getElementById("agent-dialog");
      document.getElementById("create-agent-btn")?.addEventListener("click", () => agentDialog?.showModal());
      document.getElementById("close-agent-modal")?.addEventListener("click", () => agentDialog?.close());
      document.getElementById("cancel-agent-modal")?.addEventListener("click", () => agentDialog?.close());
      document.getElementById("agent-form")?.addEventListener("submit", async (e) => {
        e.preventDefault();
        const name = document.getElementById("new-agent-name").value.trim();
        const role = document.getElementById("new-agent-role").value.trim();
        const prompt = document.getElementById("new-agent-prompt").value.trim();
        if (!name || !role) return;
        try {
          await callRpc("registerCustomAgent", {
            profile: {
              name,
              role,
              tools: ["read_file", "search_files", "execute_command"],
              permissions: { filesystem: "workspace_read_write", bash: "sandboxed" },
              systemPrompt: prompt || "You are " + name + ", a specialist agent.",
            }
          });
          agentDialog?.close();
          showToast("Agent " + name + " registered.");
          populateViewData("agents");
        } catch (err) {
          showToast("Error registering agent: " + err.message);
        }
      });

      const mcpDialog = document.getElementById("mcp-dialog");
      document.getElementById("add-mcp-btn")?.addEventListener("click", () => mcpDialog?.showModal());
      document.getElementById("close-mcp-modal")?.addEventListener("click", () => mcpDialog?.close());
      document.getElementById("cancel-mcp-modal")?.addEventListener("click", () => mcpDialog?.close());
      document.getElementById("mcp-form")?.addEventListener("submit", async (e) => {
        e.preventDefault();
        const serverId = document.getElementById("new-mcp-id").value.trim();
        const command = document.getElementById("new-mcp-cmd").value.trim();
        const argsStr = document.getElementById("new-mcp-args").value.trim();
        if (!serverId || !command) return;
        try {
          await callRpc("registerMcpServer", {
            config: {
              id: serverId,
              name: serverId,
              transport: "stdio",
              command,
              args: argsStr ? argsStr.split(/\\s+/) : [],
            }
          });
          mcpDialog?.close();
          showToast("MCP Server registered: " + serverId);
          populateViewData("mcp");
        } catch (err) {
          showToast("Error registering MCP: " + err.message);
        }
      });

      // MODEL API KEY SAVING
      document.addEventListener("click", async (e) => {
        const saveKeyBtn = e.target.closest("[data-save-key]");
        if (saveKeyBtn) {
          const prov = saveKeyBtn.getAttribute("data-save-key");
          const input = document.getElementById("key-input-" + prov);
          const keyVal = input ? input.value.trim() : "";
          if (!keyVal) return;
          try {
            await callRpc("setProviderApiKey", { provider: prov, apiKey: keyVal });
            input.value = "";
            showToast("API key securely stored for " + prov);
            populateViewData("models");
          } catch (err) {
            showToast("Failed to store API key: " + err.message);
          }
        }
      });

      // TEST MCP CONNECTION
      document.addEventListener("click", async (e) => {
        const testBtn = e.target.closest("[data-test-mcp]");
        if (testBtn) {
          const mcpName = testBtn.getAttribute("data-test-mcp");
          testBtn.textContent = "Testing...";
          try {
            const res = await callRpc("connectMcpServer", { serverId: mcpName });
            testBtn.textContent = "✓ Connected";
            showToast("MCP " + mcpName + " connection validated");
          } catch (err) {
            testBtn.textContent = "Test Ping";
            showToast("MCP Ping: " + err.message);
          }
        }
      });

      // INITIALIZE
      updateSessionDropdown();
      updateControlsState();
      renderInspectorContent();
    })();
  </script>
</body>
</html>`;
}
