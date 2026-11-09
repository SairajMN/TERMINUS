import { spawn } from "node:child_process";

export interface CommandResult {
  exitCode: number;
  output: string;
  truncated: boolean;
  timedOut: boolean;
}

export interface RunCommandOptions {
  cwd: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
  env?: Record<string, string>;
  isolateEnv?: boolean;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BYTES = 64_000;

const SENSITIVE_ENV_KEYS =
  /^(ANTHROPIC_API_KEY|OPENAI_API_KEY|NEBIUS_API_KEY|GEMINI_API_KEY|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|GITHUB_TOKEN|GH_TOKEN|NPM_TOKEN|SLACK_BOT_TOKEN|TERMINUS_.*)$/i;

/**
 * Sanitizes an environment map by stripping master API keys and infrastructure
 * secrets that the agent harness holds, preventing executed child processes from
 * reading them via `env` or `printenv`.
 */
export function sanitizeEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !SENSITIVE_ENV_KEYS.test(key)) {
      clean[key] = value;
    }
  }
  return clean;
}

export function runCommand(command: string, options: RunCommandOptions): Promise<CommandResult> {
  return new Promise((resolveResult) => {
    const shouldIsolate = options.isolateEnv !== false;
    const processEnv = shouldIsolate
      ? sanitizeEnv(options.env ?? process.env)
      : (options.env ?? process.env);

    const child = spawn(command, {
      cwd: options.cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: processEnv,
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
