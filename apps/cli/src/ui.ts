let out: { write(text: string): unknown } = process.stdout;

export const setUiOutput = (stream: { write(text: string): unknown }): void => {
  out = stream;
};

export const uiWrite = (text: string): void => {
  out.write(text);
};

const colored = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (rgb: string) => (text: string) =>
  colored ? `\x1b[38;2;${rgb}m${text}\x1b[0m` : text;

const muted = paint("138,148,163");
const accent = paint("185,154,95");
const header = (text: string) =>
  colored ? `\x1b[48;2;27;42;68m\x1b[38;2;215;219;224m${text}\x1b[0m` : text;

export const firstRun = (): string =>
  [
    "",
    `  ${header(" TERMINUS ")}  ${muted("autonomous coding agent for your codebase")}`,
    "",
    "  It researches the project, plans the work, asks for your approval,",
    "  edits inside a permission gate, runs the project's own checks, and",
    "  reports what actually passed.",
    "",
    `  ${accent("SET UP")} (once)`,
    "    put your keys in ~/.terminus/.env so terminus works from any folder:",
    "      NEBIUS_API_KEY=...            tokenfactory.nebius.com",
    "      TAVILY_API_KEY=tvly-...       optional deep research",
    "    (shell environment variables also work and always win)",
    "",
    `  ${accent("RUN")}`,
    '    bun run terminus "add input validation to the signup form"',
    '    bun run terminus --dir ../my-app "fix the failing auth test"',
    '    bun run terminus --mode plan "how should we structure the API client?"',
    '    bun run terminus --mode ask "what does src/billing do?"',
    "",
    `  ${accent("FLAGS")}`,
    "    --mode ask|plan|audit|act|auto    default act: plan, approve, edit, review",
    "    --yes                             approve low-risk actions without asking",
    '    --verify "cmd1,cmd2"              checks to run at the end',
    "    --model <id>                      model override",
    "    --provider nebius | anthropic     inference backend override",
    "    --report json                     machine-readable report on stdout",
    "    --timeout <sec>                   per-command timeout override",
    "    --sessions                        list recent sessions for this workspace",
    "    --debt                            list shortcut: comments on record",
    "    --resume <id>                     continue with an earlier session's context",
    "",
    `  ${accent("INTERACTIVE")}`,
    "    Run with no task for a session REPL: chat freely, task-like",
    "    lines run the full loop and share context with the chat.",
    "    /clear resets it, /sessions lists stored runs, /debt shows the",
    "    shortcut: ledger, /quit exits.",
    "    Approval prompts accept [a]lways to remember a command this session.",
    "",
    `  ${accent("SAFETY")}`,
    "    Plans are approved before any change. Every command is checked",
    "    against the policy; dangerous operations are blocked or require",
    "    explicit approval. Completion is reported from check results,",
    "    never from prose.",
    "",
    `  ${muted("policy overrides: ~/.terminus/policy.local.json (deny rules only)")}`,
    `  ${muted("session log:      ~/.terminus/terminus.db")}`,
    "",
  ].join("\n");
