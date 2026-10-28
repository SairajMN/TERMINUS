import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface SkillMetadata {
  name: string;
  description: string;
  path: string;
  content: string;
}

const parseFrontmatter = (text: string): { name?: string; description?: string; body: string } => {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match?.[1]) return { body: text };

  const rawMeta = match[1];
  const body = match[2] ?? "";

  let name: string | undefined;
  let description: string | undefined;

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
    }
  }

  return { name, description, body };
};

/**
 * Scans a directory recursively to discover all SKILL.md files.
 */
export function discoverSkills(skillsDir: string): SkillMetadata[] {
  const results: SkillMetadata[] = [];

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
            results.push({
              name,
              description: description ?? "",
              path: fullPath,
              content: raw,
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
 */
export function matchSkills(task: string, skills: SkillMetadata[]): SkillMetadata[] {
  const lowerTask = task.toLowerCase();
  const scored = skills
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
