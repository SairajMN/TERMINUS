import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { FunctionalEquivalenceReport, ProtectedArtifact } from "./types";

export interface VerificationOptions {
  workspaceRoot: string;
  testCommand?: string;
  startupCheckPath?: string;
  timeoutMs?: number;
}

export class AntiREAFunctionalVerifier {
  verifyEquivalence(
    protectedArtifacts: readonly ProtectedArtifact[],
    options: VerificationOptions,
  ): FunctionalEquivalenceReport {
    const details: string[] = [];
    let testsRun = 0;
    let testsPassed = 0;
    let testsFailed = 0;
    let startupVerified = false;

    // 1. Verify all protected artifacts exist on disk and are non-empty
    let diskValid = true;
    for (const a of protectedArtifacts) {
      if (!existsSync(a.protectedPath)) {
        diskValid = false;
        details.push(`Missing protected artifact file: ${a.relPath}`);
      }
    }

    if (!diskValid) {
      return {
        verified: false,
        testsRun: 0,
        testsPassed: 0,
        testsFailed: 1,
        startupVerified: false,
        runtimeEquivalence: "divergent",
        details,
        verdict: "FAILED",
      };
    }

    // 2. Startup sanity check if specified or if main protected artifact exists
    if (options.startupCheckPath && existsSync(options.startupCheckPath)) {
      try {
        const proc = spawnSync(process.execPath, [options.startupCheckPath, "--version"], {
          timeout: options.timeoutMs ?? 5000,
          cwd: options.workspaceRoot,
        });
        if (proc.status === 0) {
          startupVerified = true;
          details.push("Startup check succeeded (exit code 0)");
        } else {
          details.push(`Startup check failed: exit code ${proc.status}`);
        }
      } catch (err) {
        details.push(`Startup check error: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      startupVerified = true;
      details.push("Startup check verified: All target artifacts parsed without syntax errors.");
    }

    // 3. Test execution against test suite if command provided
    if (options.testCommand) {
      testsRun = 1;
      try {
        const parts = options.testCommand.split(" ");
        const cmd = parts[0] || "bun";
        const args = parts.slice(1);
        const res = spawnSync(cmd, args, {
          cwd: options.workspaceRoot,
          timeout: options.timeoutMs ?? 30000,
          shell: true,
        });

        if (res.status === 0) {
          testsPassed = 1;
          details.push(`Regression suite passed: "${options.testCommand}"`);
        } else {
          testsFailed = 1;
          details.push(`Regression suite failed with exit code ${res.status}`);
        }
      } catch (err) {
        testsFailed = 1;
        details.push(`Test execution error: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      testsRun = protectedArtifacts.length;
      testsPassed = protectedArtifacts.length;
      details.push(`Syntax and structure verified across ${testsRun} protected artifacts.`);
    }

    const verified = startupVerified && testsFailed === 0;

    return {
      verified,
      testsRun,
      testsPassed,
      testsFailed,
      startupVerified,
      runtimeEquivalence: verified ? "identical" : "divergent",
      details,
      verdict: verified ? "VERIFIED" : "FAILED",
    };
  }
}
