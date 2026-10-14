import { spawn } from "node:child_process";

export interface CommandResult {
  exitCode: number;
  output: string;
  truncated: boolean;
  timedOut: boolean;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BYTES = 64_000;

export function runCommand(
  command: string,
  options: { cwd: string; signal?: AbortSignal; timeoutMs?: number; maxBytes?: number },
): Promise<CommandResult> {
  return new Promise((resolveResult) => {
    const child = spawn(command, {
      cwd: options.cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    let output = "";
    let truncated = false;
    let timedOut = false;

    const sink = (chunk: Buffer) => {
      if (output.length >= maxBytes) {
        truncated = true;
        return;
      }
      output += chunk.toString("utf8");
      if (output.length > maxBytes) {
        output = output.slice(0, maxBytes);
        truncated = true;
      }
    };
    child.stdout?.on("data", sink);
    child.stderr?.on("data", sink);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000).unref();
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    timer.unref();

    const onAbort = () => child.kill("SIGTERM");
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (error) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolveResult({ exitCode: 127, output: `${output}\n${error.message}`, truncated, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolveResult({ exitCode: code ?? (timedOut ? 124 : 1), output, truncated, timedOut });
    });
  });
}
