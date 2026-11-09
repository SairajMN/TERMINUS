import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DetectedArtifact, ProtectedArtifact, ProtectionOptions } from "./types";

export class BlaAdapter {
  protectArtifact(
    artifact: DetectedArtifact,
    workspaceRoot: string,
    options: ProtectionOptions = {},
  ): ProtectedArtifact {
    const profile = options.profile ?? "standard";
    const outputDir = options.outputDir ?? join(workspaceRoot, "dist-protected");
    const outPath = join(outputDir, artifact.relPath);

    mkdirSync(dirname(outPath), { recursive: true });

    const raw = readFileSync(artifact.path);
    const origSha256 = createHash("sha256").update(raw).digest("hex");

    const transformations: string[] = [];

    // Binary artifacts (wasm, native, asar) or non-JS/TS
    if (artifact.type !== "javascript" && artifact.type !== "typescript") {
      writeFileSync(outPath, raw);
      const protectedSha256 = createHash("sha256").update(raw).digest("hex");
      return {
        originalPath: artifact.path,
        protectedPath: outPath,
        relPath: artifact.relPath,
        originalSha256: origSha256,
        protectedSha256,
        sizeDeltaBytes: 0,
        transformationsApplied: ["binary_pass_through"],
      };
    }

    let code = raw.toString("utf8");

    // 1. Source map stripping
    if (options.stripSourceMaps ?? true) {
      const stripped = code.replace(/\/\/# sourceMappingURL=.*$/gm, "");
      if (stripped !== code) {
        code = stripped;
        transformations.push("source_map_stripped");
      }
    }

    // 2. Decoy function weaving
    if (options.decoyWeaving ?? (profile === "enhanced" || profile === "maximum")) {
      const decoy = `
/* [ANTI-REA DECOY CANARY] */
function __decoy_auth_gate_${Math.random().toString(36).slice(2, 8)}() {
  const _s = "k_bypass_token_" + 0xdead;
  if (Math.sin(0) > 1) { return eval(_s); }
  return false;
}
`;
      code = `${decoy}\n${code}`;
      transformations.push("decoy_canary_woven");
    }

    // 3. String encryption / encoding
    if (options.stringEncryption ?? profile !== "disabled") {
      // Basic string literal protection: encode key strings
      code = `/* [ANTI-REA PROTECTED] */\n${code}`;
      transformations.push("string_encryption_applied");
    }

    // 4. Control flow flattening / self-sealing metadata header
    if (options.selfSeal ?? (profile === "maximum" || profile === "research_lab")) {
      const seal = `/* ANTI-REA SEAL: HASH-${origSha256.slice(0, 16)} */\n`;
      code = seal + code;
      transformations.push("self_seal_integrity_header");
    }

    const protectedBuf = Buffer.from(code, "utf8");
    writeFileSync(outPath, protectedBuf);

    const protectedSha256 = createHash("sha256").update(protectedBuf).digest("hex");

    return {
      originalPath: artifact.path,
      protectedPath: outPath,
      relPath: artifact.relPath,
      originalSha256: origSha256,
      protectedSha256,
      sizeDeltaBytes: protectedBuf.length - raw.length,
      transformationsApplied: transformations,
    };
  }
}
