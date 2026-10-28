import { type Dirent, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_SKIP_DIRS } from "@terminus/shared";
import { discoverSkills, matchSkills } from "./skills";

const MAX_DEPTH = 3;
const MANIFESTS = ["package.json", "pyproject.toml", "Cargo.toml", "go.mod"] as const;

const summarizeManifest = (root: string, name: string): string | null => {
  if (name !== "package.json") return name;
  try {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      name?: string;
      scripts?: Record<string, string>;
    };
    const scripts = Object.keys(manifest.scripts ?? {}).join(", ");
    return `package.json${manifest.name ? ` (${manifest.name})` : ""}${scripts ? ` scripts: ${scripts}` : ""}`;
  } catch {
    return "package.json (unreadable)";
  }
};

export const buildRepoMap = (root: string): string => {
  const lines: string[] = ["repository layout:"];

  const render = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries
      .filter((entry) => !entry.name.startsWith(".") && !DEFAULT_SKIP_DIRS.has(entry.name))
      .sort(
        (a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name),
      )
      .forEach((entry) => {
        lines.push(`${"  ".repeat(depth)}${entry.name}${entry.isDirectory() ? "/" : ""}`);
        if (entry.isDirectory()) render(join(dir, entry.name), depth + 1);
      });
  };
  render(root, 0);

  const summaries = MANIFESTS.map((name) => {
    try {
      readFileSync(join(root, name));
    } catch {
      return null;
    }
    return summarizeManifest(root, name);
  }).filter((line): line is string => line !== null);
  if (summaries.length > 0) {
    lines.push("", "manifests:");
    for (const summary of summaries) lines.push(`  ${summary}`);
  }
  return lines.join("\n");
};

export const loadInstructions = (root: string, task?: string): string | null => {
  let instructions: string | null = null;
  for (const name of ["AGENTS.md", "TERMINUS.md", ".terminus/instructions.md"]) {
    try {
      const content = readFileSync(join(root, name), "utf8").trim();
      if (content.length > 0) {
        instructions = content;
        break;
      }
    } catch {}
  }

  if (task) {
    try {
      const skillsDir = join(root, "skills");
      const discovered = discoverSkills(skillsDir);
      const matched = matchSkills(task, discovered);
      if (matched.length > 0 && matched[0]) {
        const top = matched[0];
        const skillBlock = `[Active Skill: ${top.name}]\n${top.content}`;
        instructions = instructions ? `${instructions}\n\n${skillBlock}` : skillBlock;
      }
    } catch {}
  }

  return instructions;
};
