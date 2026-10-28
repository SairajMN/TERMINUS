import { describe, expect, it } from "bun:test";
import {
  encapsulateContext,
  hydrateCapsule,
  parseCapsule,
  serializeCapsule,
  validateCapsule,
} from "./capsule";
import { EvidenceStore } from "./evidence";

describe("context capsule", () => {
  it("serializes and parses roundtrip accurately", () => {
    const original = {
      goal: "Implement auth middleware",
      topic: "Security",
      entities: ["src/auth.ts", "src/session.ts"],
      instructions: "Ensure JWT expiration is strictly validated",
      constraints: ["workspace-only", "re-verify", "no-secrets"],
      summary: "Added JWT verify with RS256 and test fixtures",
      anchors: [
        { path: "src/auth.ts", hashPrefix: "a1b2c3d" },
        { path: "src/session.ts", hashPrefix: "e5f6g7h" },
      ],
      verification: {
        passed: ["npm run test", "npm run lint"],
        failed: ["npm run typecheck"],
      },
    };

    const serialized = serializeCapsule(original);
    expect(serialized).toStartWith("Capsule: ");
    expect(serialized).toContain("G:Implement auth middleware");
    expect(serialized).toContain("C:workspace-only,re-verify,no-secrets");
    expect(serialized).toContain("A:src/auth.ts#a1b2c3d,src/session.ts#e5f6g7h");
    expect(serialized).toContain("V:pass:npm run test,npm run lint;fail:npm run typecheck");
    expect(serialized).toContain("SUM:Added JWT verify with RS256 and test fixtures");

    const parsed = parseCapsule(serialized);
    expect(parsed).not.toBeNull();
    expect(parsed?.goal).toBe(original.goal);
    expect(parsed?.topic).toBe(original.topic);
    expect(parsed?.entities).toEqual(original.entities);
    expect(parsed?.instructions).toBe(original.instructions);
    expect(parsed?.constraints).toEqual(original.constraints);
    expect(parsed?.summary).toBe(original.summary);
    expect(parsed?.anchors).toEqual(original.anchors);
    expect(parsed?.verification).toEqual(original.verification);
  });

  it("handles minimal capsules without optional anchors or verifiers", () => {
    const raw =
      "Capsule: G:Fix bug|T:Math|E:calc.ts|I:Fix average divisor|C:workspace-only|SUM:Fixed zero division edge case";
    const parsed = parseCapsule(raw);
    expect(parsed).not.toBeNull();
    expect(parsed?.goal).toBe("Fix bug");
    expect(parsed?.topic).toBe("Math");
    expect(parsed?.entities).toEqual(["calc.ts"]);
    expect(parsed?.instructions).toBe("Fix average divisor");
    expect(parsed?.constraints).toEqual(["workspace-only"]);
    expect(parsed?.summary).toBe("Fixed zero division edge case");
    expect(parsed?.anchors).toBeUndefined();
    expect(parsed?.verification).toBeUndefined();

    expect(parsed).not.toBeNull();
    if (!parsed) return;
    const reserialized = serializeCapsule(parsed);
    expect(reserialized).toBe(raw);
  });

  it("programmatically encapsulates an EvidenceStore preserving anchors", () => {
    const store = new EvidenceStore();
    store.add({
      kind: "source",
      source: "src/date.ts",
      content: "export const now = () => Date.now();",
    });

    const capsule = encapsulateContext({
      goal: "Format dates",
      topic: "Date utilities",
      instructions: "Add timezone formatter",
      summary: "Implemented formatForTimezone using Intl API",
      evidence: store,
      checks: [
        { command: "npm test", passed: true },
        { command: "npm run lint", passed: false },
      ],
    });

    expect(capsule.goal).toBe("Format dates");
    expect(capsule.entities).toContain("src/date.ts");
    expect(capsule.anchors?.length).toBe(1);
    expect(capsule.anchors?.[0]?.path).toBe("src/date.ts");
    expect(capsule.verification?.passed).toContain("npm test");
    expect(capsule.verification?.failed).toContain("npm run lint");

    const validation = validateCapsule(capsule);
    expect(validation.valid).toBe(true);
  });

  it("hydrates a capsule into prompt context with constraint enforcement", () => {
    const capsule = {
      goal: "Fix tokenizer",
      topic: "NLP",
      entities: ["src/token.ts"],
      instructions: "Preserve punctuation symbols",
      constraints: ["workspace-only", "no-network"],
      summary: "Updated regex to keep ASCII punctuation",
    };

    const hydrated = hydrateCapsule(capsule);
    expect(hydrated.prompt).toContain("[Context Capsule: Fix tokenizer (NLP)]");
    expect(hydrated.prompt).toContain("Enforced Constraints: workspace-only, no-network");
    expect(hydrated.prompt).toContain("Active Entities: src/token.ts");
    expect(hydrated.constraints).toEqual(["workspace-only", "no-network"]);
    expect(hydrated.staleAnchors).toBeEmpty();
  });
});
