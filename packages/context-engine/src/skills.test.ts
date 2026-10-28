import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverSkills, matchSkills } from "./skills";

describe("skills discovery and matching", () => {
  it("discovers skills and parses frontmatter correctly", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "skills-test-"));
    const secSkillDir = join(tempDir, "security", "sql-check");
    mkdirSync(secSkillDir, { recursive: true });

    writeFileSync(
      join(secSkillDir, "SKILL.md"),
      `---
name: sql-check
description: "Audits SQL queries for injection vulnerabilities and unescaped inputs"
---
# SQL Check SOP
Check for string concatenated SQL.
`,
    );

    const discovered = discoverSkills(tempDir);
    expect(discovered.length).toBe(1);
    expect(discovered[0]?.name).toBe("sql-check");
    expect(discovered[0]?.description).toContain("Audits SQL queries");
    expect(discovered[0]?.content).toContain("SQL Check SOP");
  });

  it("matches relevant skills to user task keywords", () => {
    const skills = [
      {
        name: "secure-code-review",
        description:
          "Systematically reviews code for SQL injection, XSS, and OWASP Top 10 vulnerabilities",
        path: "/path/to/sec/SKILL.md",
        content: "# Security",
      },
      {
        name: "landing-page-scaffold",
        description: "Generates high-converting landing page HTML prototypes with hero and pricing",
        path: "/path/to/land/SKILL.md",
        content: "# Landing Page",
      },
    ];

    const secMatches = matchSkills("please check this code for SQL injection risks", skills);
    expect(secMatches.length).toBeGreaterThan(0);
    expect(secMatches[0]?.name).toBe("secure-code-review");

    const uiMatches = matchSkills("build a marketing landing page with hero section", skills);
    expect(uiMatches.length).toBeGreaterThan(0);
    expect(uiMatches[0]?.name).toBe("landing-page-scaffold");
  });
});
