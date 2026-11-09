import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type SkillScope = "bundled" | "workspace" | "user" | "agent" | "imported";
export type SkillTrustState = "trusted" | "quarantined";

export interface SkillMetadata {
  name: string;
  description: string;
  path: string;
  content: string;
  scope?: SkillScope;
  trustState?: SkillTrustState;
  sha256?: string;
  enabled?: boolean;
}

export interface SkillValidationResult {
  valid: boolean;
  name?: string;
  description?: string;
  license?: string;
  body: string;
  errors: string[];
}

const parseFrontmatter = (
  text: string,
): { name?: string; description?: string; license?: string; body: string } => {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match?.[1]) return { body: text };

  const rawMeta = match[1];
  const body = match[2] ?? "";

  let name: string | undefined;
  let description: string | undefined;
  let license: string | undefined;

  for (const line of rawMeta.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim().toLowerCase();
      let val = line.slice(colonIdx + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (key === "name") name = val;
      if (key === "description") description = val;
      if (key === "license") license = val;
    }
  }

  return { name, description, license, body };
};

export function computeSkillHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function validateSkillMarkdown(text: string): SkillValidationResult {
  const errors: string[] = [];
  const parsed = parseFrontmatter(text);
  if (!parsed.name) {
    errors.push("Missing required YAML frontmatter field: 'name'");
  } else if (!/^[a-z0-9-]+$/.test(parsed.name)) {
    errors.push("Skill 'name' must be kebab-case (lowercase letters, digits, hyphens)");
  }
  if (!parsed.description || parsed.description.trim().length < 10) {
    errors.push(
      "Skill 'description' must be at least 10 characters and describe trigger scenarios",
    );
  }
  if (parsed.body.trim().length < 10) {
    errors.push("Skill markdown body is empty or too short");
  }
  return {
    valid: errors.length === 0,
    name: parsed.name,
    description: parsed.description,
    license: parsed.license,
    body: parsed.body,
    errors,
  };
}

/**
 * Scans a directory recursively to discover all SKILL.md files.
 */
export function discoverSkills(
  skillsDir: string,
  options?: {
    scope?: SkillScope;
    defaultTrust?: SkillTrustState;
    trustedHashes?: Record<string, string>;
  },
): SkillMetadata[] {
  const results: SkillMetadata[] = [];
  const scope = options?.scope ?? "workspace";
  const defaultTrust = options?.defaultTrust ?? (scope === "imported" ? "quarantined" : "trusted");

  const walk = (dir: string) => {
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      const fullPath = join(dir, entry);
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        walk(fullPath);
      } else if (entry === "SKILL.md") {
        try {
          const raw = readFileSync(fullPath, "utf8");
          const { name, description } = parseFrontmatter(raw);
          if (name) {
            const sha256 = computeSkillHash(raw);
            const approvedHash = options?.trustedHashes?.[name];
            const trustState: SkillTrustState =
              defaultTrust === "trusted"
                ? "trusted"
                : approvedHash === sha256
                  ? "trusted"
                  : "quarantined";
            results.push({
              name,
              description: description ?? "",
              path: fullPath,
              content: raw,
              scope,
              trustState,
              sha256,
              enabled: true,
            });
          }
        } catch {}
      }
    }
  };

  walk(skillsDir);
  return results;
}

/**
 * Matches available skills against a user task or prompt using keyword relevance.
 * Quarantined or disabled skills are never auto-matched into execution context.
 */
export function matchSkills(task: string, skills: SkillMetadata[]): SkillMetadata[] {
  const lowerTask = task.toLowerCase();
  const scored = skills
    .filter((skill) => skill.enabled !== false && skill.trustState !== "quarantined")
    .map((skill) => {
      let score = 0;
      const lowerName = skill.name.toLowerCase();
      const lowerDesc = skill.description.toLowerCase();

      // Direct name match or mention
      if (lowerTask.includes(lowerName)) {
        score += 10;
      }

      // Keyword token matches
      const tokens = lowerDesc
        .split(/\W+/)
        .filter(
          (t) =>
            t.length > 3 && !["this", "when", "that", "with", "from", "user", "users"].includes(t),
        );

      for (const token of tokens) {
        if (lowerTask.includes(token)) {
          score += 1;
        }
      }

      return { skill, score };
    })
    .filter((entry) => entry.score >= 2)
    .sort((a, b) => b.score - a.score);

  return scored.map((e) => e.skill);
}

export class SkillRegistryManager {
  private readonly trustFilePath: string;
  private readonly disabledSkills = new Set<string>();

  constructor(options?: { trustFilePath?: string }) {
    this.trustFilePath =
      options?.trustFilePath ?? join(homedir(), ".terminus", "trusted-skills.json");
  }

  loadTrustedHashes(): Record<string, string> {
    if (!existsSync(this.trustFilePath)) return {};
    try {
      return JSON.parse(readFileSync(this.trustFilePath, "utf8")) as Record<string, string>;
    } catch {
      return {};
    }
  }

  approveQuarantinedSkill(name: string, content: string): string {
    const current = this.loadTrustedHashes();
    const hash = computeSkillHash(content);
    current[name] = hash;
    mkdirSync(dirname(this.trustFilePath), { recursive: true });
    writeFileSync(this.trustFilePath, JSON.stringify(current, null, 2), "utf8");
    return hash;
  }

  setSkillEnabled(name: string, enabled: boolean): void {
    if (enabled) this.disabledSkills.delete(name);
    else this.disabledSkills.add(name);
  }

  discoverAllScoped(options: {
    workspaceRoot: string;
    bundledSkillsRoot?: string;
    userSkillsRoot?: string;
    importedSkillsRoot?: string;
  }): SkillMetadata[] {
    const trustedHashes = this.loadTrustedHashes();
    const userRoot = options.userSkillsRoot ?? join(homedir(), ".terminus", "skills");
    const importedRoot =
      options.importedSkillsRoot ?? join(homedir(), ".terminus", "skills-imported");
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    const bundledRoot = options.bundledSkillsRoot ?? join(moduleDir, "..", "..", "..", "skills");

    const all = [
      ...discoverSkills(join(options.workspaceRoot, "skills"), {
        scope: "workspace",
        defaultTrust: "trusted",
      }),
      ...discoverSkills(userRoot, {
        scope: "user",
        defaultTrust: "trusted",
      }),
      ...discoverSkills(importedRoot, {
        scope: "imported",
        defaultTrust: "quarantined",
        trustedHashes,
      }),
      ...discoverSkills(bundledRoot, {
        scope: "bundled",
        defaultTrust: "trusted",
      }),
    ];

    const deduped = new Map<string, SkillMetadata>();
    for (const s of all) {
      if (!deduped.has(s.name)) {
        deduped.set(s.name, {
          ...s,
          enabled: !this.disabledSkills.has(s.name),
        });
      }
    }
    return [...deduped.values()];
  }
}
