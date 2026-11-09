import { existsSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import type { ArtifactInventory, ArtifactType, DetectedArtifact } from "./types";

export class ArtifactClassifier {
  classifyFile(filePath: string, workspaceRoot: string): DetectedArtifact | null {
    if (!existsSync(filePath)) return null;
    const stat = statSync(filePath);
    if (!stat.isFile()) return null;

    const ext = extname(filePath).toLowerCase();
    let type: ArtifactType;
    if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
      type = "javascript";
    } else if (ext === ".ts" || ext === ".mts" || ext === ".cts") {
      type = "typescript";
    } else if (ext === ".wasm") {
      type = "wasm";
    } else if (ext === ".asar") {
      type = "electron_asar";
    } else if (ext === ".py" || ext === ".pyc") {
      type = "python";
    } else if (ext === ".node" || ext === ".dylib" || ext === ".so" || ext === ".dll") {
      type = "native";
    } else {
      return null;
    }

    const relPath = relative(workspaceRoot, filePath);
    const hasSourceMap = existsSync(`${filePath}.map`);

    return {
      path: filePath,
      relPath,
      type,
      sizeBytes: stat.size,
      hasSourceMap,
      exposedSymbols: [],
    };
  }

  scanWorkspace(workspaceRoot: string, maxDepth = 4): ArtifactInventory {
    const artifacts: DetectedArtifact[] = [];

    const walk = (dir: string, depth: number) => {
      if (depth > maxDepth) return;
      if (!existsSync(dir)) return;

      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (
          entry.name === "node_modules" ||
          entry.name === ".git" ||
          entry.name === "dist-protected" ||
          entry.name === "coverage"
        ) {
          continue;
        }

        if (entry.isDirectory()) {
          walk(fullPath, depth + 1);
        } else if (entry.isFile()) {
          const classified = this.classifyFile(fullPath, workspaceRoot);
          if (classified) artifacts.push(classified);
        }
      }
    };

    walk(workspaceRoot, 0);

    const totalBytes = artifacts.reduce((acc, a) => acc + a.sizeBytes, 0);
    const hasExposedSourceMaps = artifacts.some((a) => a.hasSourceMap);
    const detectedTypes = Array.from(new Set(artifacts.map((a) => a.type)));

    return {
      workspaceRoot,
      artifacts,
      totalBytes,
      hasExposedSourceMaps,
      detectedTypes,
    };
  }
}
