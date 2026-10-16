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
    `  ${header(" TERMINUS ")}  ${muted("research → plan → approve → edit → verify → report")}`,
    "",
    `  ${accent("setup")}   keys in ~/.terminus/.env (or shell env) — works from any folder:`,
    "      NEBIUS_API_KEY=...          tokenfactory.nebius.com",
    "      TAVILY_API_KEY=tvly-...     optional deep research",
    "",
    `  ${accent("run")}     terminus "add input validation to the signup form"`,
    `    ${muted('terminus --mode plan "how should we structure the API client?"')}`,
    `    ${muted("terminus    interactive: chat freely; task-like lines run the loop")}`,
    "",
    `  ${accent("flags")}   --mode ask|plan|audit|act|auto   --yes   --verify "cmd1,cmd2"`,
    `    ${muted("--model <id>   --provider nebius|anthropic   --report json   --timeout <sec>")}`,
    `    ${muted("--sessions   --resume <id>   --debt   --version   (REPL: /help /clear /quit)")}`,
    "",
    `  ${muted("plans approved before changes · dangerous commands blocked or asked ·")}`,
    `  ${muted("completion proven by checks, never prose · policy ~/.terminus/policy.local.json")}`,
    "",
  ].join("\n");
