import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Keys the agent knows to look for; never logged, never overridden. */
const MANAGED = [
  "NEBIUS_API_KEY",
  "NEBIUS_BASE_URL",
  "NEBIUS_MODEL",
  "TAVILY_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
];

/**
 * Load ~/.terminus/.env so the installed CLI works from any directory.
 * Real environment variables always win; values are never printed.
 */
export const loadHomeEnv = (path?: string): string[] => {
  const file = path ?? join(homedir(), ".terminus", ".env");
  if (!existsSync(file)) return [];
  const loaded: string[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    const key = match?.[1];
    if (!key || !MANAGED.includes(key)) continue;
    const value = (match[2] ?? "").trim().replace(/^(["'])(.*)\1$/, "$2");
    if (value.length > 0 && !process.env[key]) {
      process.env[key] = value;
      loaded.push(key);
    }
  }
  return loaded;
};
