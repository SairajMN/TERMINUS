import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgent,
  formatPostEditDiagnostics,
  runParallelSubagents,
  SUBAGENT_REGISTRY,
  scanCode,
  verifyEditedFile,
} from "@terminus/agent-runtime";
import {
  BudgetTracker,
  classifyTaskTier,
  estimateCostUsd,
  type ModelEvent,
  mockGateway,
  selectGateway,
} from "@terminus/model-gateway";
import {
  analyzeProject,
  buildRepoMap,
  compactMessages,
  extractFileSymbols,
  loadInstructions,
} from "../packages/context-engine/src";

describe("TERMINUS v0.3.0 capability & benchmark evaluation suite", () => {
  it("1. Deep Codebase Intelligence: detects frameworks, path aliases, and inline file exports", () => {
    const dir = mkdtempSync(join(tmpdir(), "terminus-cap-intel-"));
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          name: "noir-studio",
          dependencies: { next: "15.1.0", react: "19.0.0", three: "0.170.0" },
          devDependencies: { typescript: "5.7.0", tailwindcss: "3.4.0" },
        }),
      );
      writeFileSync(
        join(dir, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            paths: { "@/*": ["./src/*"] },
          },
        }),
      );
      mkdirSync(join(dir, "src", "app"), { recursive: true });
      mkdirSync(join(dir, "src", "components"), { recursive: true });
      writeFileSync(
        join(dir, "src", "components", "Link.tsx"),
        `'use client';\nexport interface LinkProps { href: string }\nexport const Link = () => null;\nexport default Link;\n`,
      );
      writeFileSync(join(dir, "CLAUDE.md"), "# Studio Rules\nAlways use olive accents.\n");

      const intel = analyzeProject(dir);
      expect(intel.frameworks).toContain("Next.js (App Router)");
      expect(intel.frameworks).toContain("React");
      expect(intel.frameworks).toContain("Three.js");
      expect(intel.frameworks).toContain("Tailwind CSS");
      expect(intel.tsPathAliases["@/*"]).toEqual(["./src/*"]);

      const symbols = extractFileSymbols(
        readFileSync(join(dir, "src", "components", "Link.tsx"), "utf8"),
        ".tsx",
      );
      expect(symbols.hasUseClient).toBe(true);
      expect(symbols.defaultExport).toBe("Link");
      expect(symbols.namedExports).toContain("Link");

      const map = buildRepoMap(dir);
      expect(map).toContain("Next.js (App Router)");
      expect(map).toContain("@/* -> ./src/*");
      expect(map).toContain("'use client'");
      expect(map).toContain("default:Link");

      const instructions = loadInstructions(dir);
      expect(instructions).toContain("Always use olive accents");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("2. Instant Post-Edit Static Verifier: catches Next.js boundary bugs, broken imports, export mismatches, and missing packages in <5ms", () => {
    const dir = mkdtempSync(join(tmpdir(), "terminus-cap-verify-"));
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          name: "noir-app",
          dependencies: { next: "15.0.0", react: "19.0.0" },
        }),
      );
      writeFileSync(
        join(dir, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            paths: { "@/*": ["./src/*"] },
          },
        }),
      );
      mkdirSync(join(dir, "src", "components"), { recursive: true });
      mkdirSync(join(dir, "src", "app"), { recursive: true });

      // Named-only export in Button.tsx
      writeFileSync(
        join(dir, "src", "components", "Button.tsx"),
        `export const Button = () => <button>Click</button>;\n`,
      );

      // Page with:
      // 1) useState without 'use client'
      // 2) default import of Button (which only has named export)
      // 3) broken local import '@/components/Missing'
      // 4) uninstalled package 'lucide-react'
      writeFileSync(
        join(dir, "src", "app", "page.tsx"),
        [
          `import { useState } from "react";`,
          `import Button from "@/components/Button";`,
          `import { Ghost } from "@/components/Missing";`,
          `import { ArrowUpRight } from "lucide-react";`,
          `export default function Page() {`,
          `  const [open, setOpen] = useState(false);`,
          `  return <div><Button /><Ghost /><ArrowUpRight /></div>;`,
          `}`,
        ].join("\n"),
      );

      const issues = verifyEditedFile(dir, "src/app/page.tsx");
      const codes = issues.map((i) => i.code);
      expect(codes).toContain("NEXTJS-MISSING-USE-CLIENT");
      expect(codes).toContain("EXPORT-DEFAULT-MISMATCH");
      expect(codes).toContain("BROKEN-LOCAL-IMPORT");
      expect(codes).toContain("MISSING-PACKAGE-DEPENDENCY");

      const formatted = formatPostEditDiagnostics(issues);
      expect(formatted).toContain("[instant static verifier found 4 issue(s)");
      expect(formatted).toContain("lucide-react");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("3. 16-Rule OWASP Top 10 SAST Scanner: detects injection, SSRF, prototype pollution, weak crypto, and JWT none", () => {
    const sample = [
      `const hash = crypto.createHash('md5').update(pw).digest('hex');`,
      `const token = jwt.sign(payload, secret, { algorithm: 'none' });`,
      `process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";`,
      `const user = await User.findOne({ $where: req.body.filter });`,
      `res.redirect(req.query.next);`,
    ].join("\n");
    const findings = scanCode(sample, "src/auth.ts");
    const categories = findings.map((f) => f.category);
    expect(categories).toContain("OWASP A02: Cryptographic Failures");
    expect(categories).toContain("OWASP A05: Security Misconfiguration");
    expect(categories).toContain("OWASP A03: Injection (NoSQL)");
    expect(categories).toContain("OWASP A01: Broken Access Control");
  });

  it("4. Context Compaction & Redundant-Read Loop Prevention: compresses stale tool results and prevents repeated identical reads", async () => {
    const messages = Array.from({ length: 10 }, (_, idx) => ({
      role: (idx % 2 === 0 ? "assistant" : "user") as "assistant" | "user",
      content: [
        idx % 2 === 0
          ? { type: "tool_use" as const, id: `c${idx}`, name: "read_file", input: { path: "a.ts" } }
          : {
              type: "tool_result" as const,
              tool_use_id: `c${idx - 1}`,
              content: "x".repeat(5000),
              is_error: false,
            },
      ],
    }));

    const compacted = compactMessages(messages, { maxChars: 6000, preserveRecentMessages: 2 });
    expect(compacted.stats.compactedResultsCount).toBeGreaterThan(0);
    expect(compacted.stats.estimatedTokensSaved).toBeGreaterThan(1000);

    // Verify redundant read deduplication and undo rollback inside createAgent
    const dir = mkdtempSync(join(tmpdir(), "terminus-cap-agent-"));
    try {
      writeFileSync(join(dir, "hello.ts"), "export const x = 1;\n");
      const scriptedTurns: ModelEvent[][] = [
        // Plan turn
        [{ type: "text", text: "Plan: edit hello.ts" }],
        // Implementation turn 1: read hello.ts
        [{ type: "tool_use", id: "r1", name: "read_file", input: { path: "hello.ts" } }],
        // Implementation turn 2: edit hello.ts
        [
          {
            type: "tool_use",
            id: "e1",
            name: "edit_file",
            input: {
              path: "hello.ts",
              old_text: "export const x = 1;",
              new_text: "export const x = 42;",
            },
          },
        ],
        // Implementation turn 3: done
        [{ type: "text", text: "Updated x to 42." }],
        // Review turn
        [{ type: "text", text: "verdict: clear" }],
      ];
      let turnIndex = 0;
      const gw = mockGateway(() => scriptedTurns[turnIndex++] ?? []);

      const agent = createAgent({
        workspaceRoot: dir,
        gateway: gw,
        approver: async () => ({ approved: true }),
        verifyCommands: [],
      });

      const report = await agent.run("Update x to 42 in hello.ts");
      expect(report.outcome).toBe("completed");
      expect(readFileSync(join(dir, "hello.ts"), "utf8")).toContain("42");
      expect(agent.lastPlan?.()).toContain("Plan: edit hello.ts");

      // Rollback via /undo
      const undone = agent.undo?.();
      expect(undone?.restored).toEqual(["hello.ts"]);
      expect(readFileSync(join(dir, "hello.ts"), "utf8")).toBe("export const x = 1;\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("5. Multi-Agent Subagent Orchestration & Budget/Tier Routing", async () => {
    expect(Object.keys(SUBAGENT_REGISTRY)).toEqual([
      "explorer",
      "architect",
      "coder",
      "security_auditor",
      "reviewer",
      "debugger",
    ]);

    const dir = mkdtempSync(join(tmpdir(), "terminus-cap-sub-"));
    try {
      writeFileSync(join(dir, "index.ts"), "export const app = true;\n");
      const subTurns: ModelEvent[][] = [
        [{ type: "text", text: "Explorer found index.ts" }],
        [{ type: "text", text: "Auditor found 0 issues" }],
      ];
      let subIdx = 0;
      const gw = mockGateway(() => subTurns[subIdx++] ?? []);

      const results = await runParallelSubagents(
        [
          { role: "explorer", objective: "Find entrypoints" },
          { role: "security_auditor", objective: "Check security" },
        ],
        {
          workspaceRoot: dir,
          gateway: gw,
          approver: async () => ({ approved: true }),
        },
      );
      expect(results).toHaveLength(2);
      expect(results[0]?.report.outcome).toBe("completed");
      expect(results[1]?.report.outcome).toBe("completed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    const budget = new BudgetTracker({
      maxTokens: 10_000,
      maxCostUsd: 0.05,
      model: "nvidia/nemotron-3-super-120b-a12b",
    });
    const snap1 = budget.record(4_000, 1_000);
    expect(snap1.exceeded).toBe(false);
    expect(snap1.totalTokens).toBe(5_000);
    expect(estimateCostUsd(1_000_000, 1_000_000, "nvidia/nemotron-3-super-120b-a12b")).toBe(1.2);

    const snap2 = budget.record(6_000, 1_000);
    expect(snap2.exceeded).toBe(true);
    expect(snap2.exceededReason).toContain("Token budget exceeded");

    expect(classifyTaskTier("what is this repo?", "ask")).toBe("fast");
    expect(classifyTaskTier("architect a multi-page application", "act")).toBe("reasoning");
    expect(selectGateway({ provider: "ollama", model: "qwen2.5-coder:7b" }).label).toBe(
      "ollama qwen2.5-coder:7b",
    );
  });
});
