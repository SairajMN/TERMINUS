export type ProtectionProfile = "disabled" | "standard" | "enhanced" | "maximum" | "research_lab";

export type ArtifactType =
  | "javascript"
  | "typescript"
  | "wasm"
  | "electron_asar"
  | "native"
  | "python";

export interface DetectedArtifact {
  readonly path: string;
  readonly relPath: string;
  readonly type: ArtifactType;
  readonly sizeBytes: number;
  readonly hasSourceMap: boolean;
  readonly exposedSymbols: string[];
}

export interface ArtifactInventory {
  readonly workspaceRoot: string;
  readonly artifacts: readonly DetectedArtifact[];
  readonly totalBytes: number;
  readonly hasExposedSourceMaps: boolean;
  readonly detectedTypes: readonly ArtifactType[];
}

export interface ProtectionOptions {
  readonly profile?: ProtectionProfile;
  readonly outputDir?: string;
  readonly preserveOriginal?: boolean;
  readonly selfSeal?: boolean;
  readonly stringEncryption?: boolean;
  readonly controlFlowObfuscation?: boolean;
  readonly decoyWeaving?: boolean;
  readonly stripSourceMaps?: boolean;
}

export interface ProtectedArtifact {
  readonly originalPath: string;
  readonly protectedPath: string;
  readonly relPath: string;
  readonly originalSha256: string;
  readonly protectedSha256: string;
  readonly sizeDeltaBytes: number;
  readonly transformationsApplied: string[];
}

export interface ProtectionResult {
  readonly success: boolean;
  readonly profile: ProtectionProfile;
  readonly outputDir: string;
  readonly protectedArtifacts: readonly ProtectedArtifact[];
  readonly durationMs: number;
  readonly warnings: string[];
}

export interface FunctionalEquivalenceReport {
  readonly verified: boolean;
  readonly testsRun: number;
  readonly testsPassed: number;
  readonly testsFailed: number;
  readonly startupVerified: boolean;
  readonly runtimeEquivalence: "identical" | "divergent" | "not_tested";
  readonly details: string[];
  readonly verdict: "VERIFIED" | "FAILED" | "UNTESTED";
}

export interface SignedReleaseManifest {
  readonly version: number;
  readonly releaseId: string;
  readonly timestamp: number;
  readonly profile: ProtectionProfile;
  readonly rootHash: string;
  readonly artifacts: readonly {
    readonly relPath: string;
    readonly sha256: string;
    readonly sizeBytes: number;
  }[];
  readonly verificationVerdict: string;
}
