import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AntiREAEngine } from "./engine";

describe("Anti-REA Subsystem (BLA & Functional Equivalence)", () => {
  const testWorkspace = join(import.meta.dir, "..", "tmp-test-anti-rea");

  it("scans workspace, protects artifacts into dist-protected, and preserves original source files", () => {
    rmSync(testWorkspace, { recursive: true, force: true });
    mkdirSync(join(testWorkspace, "src"), { recursive: true });

    const originalSource =
      'export function secretAuth() { return "super-secure-token"; }\n//# sourceMappingURL=index.js.map';
    const filePath = join(testWorkspace, "src", "index.ts");
    writeFileSync(filePath, originalSource, "utf8");

    const engine = new AntiREAEngine();
    const inventory = engine.scanInventory(testWorkspace);
    expect(inventory.artifacts.length).toBeGreaterThanOrEqual(1);

    const { result, verification, manifest } = engine.protect(testWorkspace, {
      profile: "enhanced",
    });
    expect(result.success).toBe(true);

    // 1. Original file remains untouched!
    expect(readFileSync(filePath, "utf8")).toBe(originalSource);

    // 2. Protected file emitted to dist-protected/
    const protectedPath = join(testWorkspace, "dist-protected", "src", "index.ts");
    expect(existsSync(protectedPath)).toBe(true);
    const protectedCode = readFileSync(protectedPath, "utf8");
    expect(protectedCode).not.toBe(originalSource);
    expect(protectedCode).toContain("[ANTI-REA PROTECTED]");
    expect(protectedCode).not.toContain("//# sourceMappingURL=");

    // 3. Functional Equivalence Verified
    expect(verification.verified).toBe(true);
    expect(verification.verdict).toBe("VERIFIED");

    // 4. Signed Release Manifest Generated
    expect(manifest.artifacts.length).toBeGreaterThanOrEqual(1);
    expect(manifest.verificationVerdict).toBe("VERIFIED");
    expect(existsSync(join(testWorkspace, "dist-protected", "release-manifest.json"))).toBe(true);

    rmSync(testWorkspace, { recursive: true, force: true });
  });
});
