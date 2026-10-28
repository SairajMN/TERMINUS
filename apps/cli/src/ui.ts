import { fitHeight, fitWidth, wrap } from "./fit";

let out: { write(text: string): unknown } = process.stdout;

export const setUiOutput = (stream: { write(text: string): unknown }): void => {
  out = stream;
};

export const uiWrite = (text: string): void => {
  out.write(text);
};

const colored =
  Boolean(process.stdout.isTTY) && !process.env.NO_COLOR && process.env.NODE_ENV !== "test";
const paint = (rgb: string) => (text: string) =>
  colored ? `\x1b[38;2;${rgb}m${text}\x1b[0m` : text;

const muted = paint("138,148,163");
const accent = paint("185,154,95");
const header = (text: string) =>
  colored ? `\x1b[48;2;27;42;68m\x1b[38;2;215;219;224m${text}\x1b[0m` : text;

export const firstRun = (width = fitWidth(), height = fitHeight()): string => {
  const lines: string[] = [""];
  lines.push(
    `  ${header(" TERMINUS ")}${
      width >= 64 ? `  ${muted("research → plan → approve → edit → verify → report")}` : ""
    }`,
    "",
  );
  const row = (
    indent: number,
    labelText: string,
    text: string,
    painter = (value: string) => value,
  ): void => {
    const gap = labelText ? Math.max(2, 10 - indent - labelText.length) : 0;
    const headLength = indent + (labelText ? labelText.length + gap : 0);
    const head = `${" ".repeat(indent)}${labelText ? `${accent(labelText)}${" ".repeat(gap)}` : ""}`;
    wrap(text, Math.max(12, width - headLength)).forEach((segment, index) => {
      lines.push(`${index === 0 ? head : " ".repeat(headLength)}${painter(segment)}`);
    });
  };
  row(2, "setup", "keys in ~/.terminus/.env (or shell env) — works from any folder:");
  row(6, "", "NEBIUS_API_KEY=...          tokenfactory.nebius.com", muted);
  row(6, "", "TAVILY_API_KEY=tvly-...     optional deep research", muted);
  lines.push("");
  row(2, "run", 'terminus "add input validation to the signup form"');
  row(4, "", 'terminus --mode plan "how should we structure the API client?"', muted);
  row(4, "", "terminus    interactive: chat freely; task-like lines run the loop", muted);
  lines.push("");
  row(2, "flags", '--mode ask|plan|audit|act|auto   --yes   --verify "cmd1,cmd2"');
  row(4, "", "--model <id>   --provider nebius|anthropic   --report json   --timeout <sec>", muted);
  row(4, "", "--sessions   --resume <id>   --debt   --version   (REPL: /help /clear /quit)", muted);
  if (height >= 18) {
    lines.push("");
    row(2, "", "plans approved before changes · dangerous commands blocked or asked ·", muted);
    row(
      2,
      "",
      "completion proven by checks, never prose · policy ~/.terminus/policy.local.json",
      muted,
    );
  }
  lines.push("");
  return lines.join("\n");
};
