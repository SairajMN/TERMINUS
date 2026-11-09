import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BlaAdapter } from "./bla-adapter";
import { ArtifactClassifier } from "./classifier";
import type {
  ArtifactInventory,
  FunctionalEquivalenceReport,
  ProtectionOptions,
  ProtectionResult,
  SignedReleaseManifest,
} from "./types";
import { AntiREAFunctionalVerifier } from "./verifier";

export class AntiREAEngine {
  private readonly classifier = new ArtifactClassifier();
  private readonly adapter = new BlaAdapter();
  private readonly verifier = new AntiREAFunctionalVerifier();

  scanInventory(workspaceRoot: string): ArtifactInventory {
    return this.classifier.scanWorkspace(workspaceRoot);
  }

  protect(
    workspaceRoot: string,
    options: ProtectionOptions = {},
  ): {
    result: ProtectionResult;
    verification: FunctionalEquivalenceReport;
    manifest: SignedReleaseManifest;
  } {
    const startTime = Date.now();
    const inventory = this.scanInventory(workspaceRoot);
    const profile = options.profile ?? "standard";
    const outputDir = options.outputDir ?? join(workspaceRoot, "dist-protected");

    mkdirSync(outputDir, { recursive: true });

    const protectedArtifacts = inventory.artifacts.map((art) =>
      this.adapter.protectArtifact(art, workspaceRoot, {
        ...options,
        outputDir,
        profile,
      }),
    );

    const durationMs = Date.now() - startTime;
    const warnings: string[] = [];

    if (inventory.hasExposedSourceMaps) {
      warnings.push(
        "Exposed source maps detected in workspace artifacts; stripped in protected build.",
      );
    }

    const result: ProtectionResult = {
      success: true,
      profile,
      outputDir,
      protectedArtifacts,
      durationMs,
      warnings,
    };

    // Mandatory Functional Equivalence Verification
    const verification = this.verifier.verifyEquivalence(protectedArtifacts, {
      workspaceRoot,
    });

    // Generate root hash and Signed Release Manifest
    const manifestHasher = createHash("sha256");
    for (const a of protectedArtifacts) {
      manifestHasher.update(`${a.relPath}:${a.protectedSha256}`);
    }
    const rootHash = manifestHasher.digest("hex");

    const manifest: SignedReleaseManifest = {
      version: 1,
      releaseId: `REL-${randomUUID().slice(0, 8)}`,
      timestamp: Date.now(),
      profile,
      rootHash,
      artifacts: protectedArtifacts.map((a) => ({
        relPath: a.relPath,
        sha256: a.protectedSha256,
        sizeBytes: a.sizeDeltaBytes,
      })),
      verificationVerdict: verification.verdict,
    };

    // Save manifest to dist-protected/release-manifest.json
    try {
      writeFileSync(
        join(outputDir, "release-manifest.json"),
        JSON.stringify(manifest, null, 2),
        "utf8",
      );
    } catch {}

    return {
      result,
      verification,
      manifest,
    };
  }
}
