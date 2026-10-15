import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Mode } from "@terminus/shared";

export interface TerminusConfig {
  mode?: Mode;
  model?: string;
  provider?: "nebius" | "anthropic";
  verify?: string[];
  timeoutSeconds?: number;
}

const readConfig = (path: string): TerminusConfig => {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as TerminusConfig;
  } catch {
    process.stderr.write(`terminus: ignoring invalid config at ${path}\n`);
    return {};
  }
};

/** Project config overrides user config; CLI flags override both (applied by the caller). */
export const loadConfig = (workspaceRoot: string): TerminusConfig => ({
  ...readConfig(join(homedir(), ".terminus", "config.json")),
  ...readConfig(join(workspaceRoot, ".terminus", "config.json")),
});
