import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { validateSkillMarkdown } from "@terminus/context-engine";
import type { BlueTeamReport } from "./blueteam/types";
import type { FailureModeKind, HarnessEvolutionEngine } from "./harness";
import type { AttackCategory, RedTeamCampaignReport } from "./redteam/types";

export interface FalsePositivePattern {
  category: AttackCategory;
  hypothesisId: string;
  reason: string;
}

export interface LearnedPlaybook {
  name: string;
  description: string;
  categoriesCovered: AttackCategory[];
  markdown: string;
}

export interface RunReflection {
  id: string;
  timestamp: number;
  campaignId: string;
  exploitsConfirmed: number;
  falsePositivesFiltered: number;
  falsePositivePatterns: FalsePositivePattern[];
  learnedPlaybook?: LearnedPlaybook;
}

const MAX_REFLECTIONS = 50;

/**
 * Distills Red/Blue security outcomes into trajectory telemetry for
 * HarnessEvolutionEngine and quarantined SKILL.md defensive playbooks.
 */
export class ReflectionEngine {
  private readonly reflections: RunReflection[] = [];

  reflect(input: {
    taskId: string;
    redTeamReport: RedTeamCampaignReport;
    blueTeamReport?: BlueTeamReport;
    evolution?: HarnessEvolutionEngine;
  }): RunReflection {
    const { taskId, redTeamReport, blueTeamReport, evolution } = input;
    const falsePositivePatterns: FalsePositivePattern[] = [];

    if (blueTeamReport?.skepticDecisions) {
      for (const dec of blueTeamReport.skepticDecisions) {
        if (!dec.confirmed) {
          const matching = redTeamReport.findings.find((f) => f.hypothesisId === dec.hypothesisId);
          if (matching?.prohibitedEffectAchieved) {
            falsePositivePatterns.push({
              category: matching.category,
              hypothesisId: dec.hypothesisId,
              reason: dec.reason,
            });
          }
        }
      }
    }

    const exploitedFindings = redTeamReport.findings.filter((f) => f.prohibitedEffectAchieved);
    let learnedPlaybook: LearnedPlaybook | undefined;

    if (exploitedFindings.length > 0) {
      const categories = [...new Set(exploitedFindings.map((f) => f.category))];
      const slug = `remediate-${redTeamReport.campaignId.toLowerCase().replace(/[^a-z0-9-]/g, "")}`;
      const description = `Verified remediation playbook covering ${categories.slice(0, 3).join(", ")} from campaign ${redTeamReport.campaignId}.`;
      const steps = exploitedFindings
        .map(
          (f, i) =>
            `${i + 1}. **${f.category}** (${f.hypothesisId}): Verify trace \`${f.observedExecutionTrace.slice(0, 120)}\` and enforce regression test.`,
        )
        .join("\n");

      const markdown = `---\nname: ${slug}\ndescription: "${description}"\n---\n\n# Verified Remediation Playbook (${redTeamReport.campaignId})\n\n${steps}\n`;
      const check = validateSkillMarkdown(markdown);
      if (check.valid) {
        learnedPlaybook = {
          name: slug,
          description,
          categoriesCovered: categories,
          markdown,
        };
      }
    }

    if (evolution) {
      const failureModes: FailureModeKind[] = [];
      if (falsePositivePatterns.length > 0) failureModes.push("false_security_confirmation");
      if (exploitedFindings.length > 0 && !blueTeamReport?.patchesApplied) {
        failureModes.push("missing_regression_test");
      }
      evolution.recordExecution({
        taskId,
        harnessName: "SecurityAuditHarness",
        verdict: exploitedFindings.length === 0 ? "VERIFIED" : "PARTIALLY_VERIFIED",
        failureModes,
      });
    }

    const reflection: RunReflection = {
      id: `REFL-${Date.now().toString(36).toUpperCase()}`,
      timestamp: Date.now(),
      campaignId: redTeamReport.campaignId,
      exploitsConfirmed: blueTeamReport?.findingsAnalyzed ?? exploitedFindings.length,
      falsePositivesFiltered: falsePositivePatterns.length,
      falsePositivePatterns,
      learnedPlaybook,
    };

    this.reflections.push(reflection);
    if (this.reflections.length > MAX_REFLECTIONS) {
      this.reflections.shift();
    }
    return reflection;
  }

  /**
   * Emits a distilled playbook strictly into the imported (quarantined) skills folder
   * so human SHA-256 review is mandatory before it enters active model prompts.
   */
  emitQuarantinedSkill(
    reflection: RunReflection,
    importedSkillsRoot = join(homedir(), ".terminus", "skills-imported"),
  ): string | null {
    const playbook = reflection.learnedPlaybook;
    if (!playbook) return null;
    const skillDir = join(importedSkillsRoot, playbook.name);
    mkdirSync(skillDir, { recursive: true });
    const filePath = join(skillDir, "SKILL.md");
    writeFileSync(filePath, playbook.markdown, "utf8");
    return filePath;
  }

  listReflections(): readonly RunReflection[] {
    return this.reflections;
  }
}
