import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { isInside } from "@terminus/shared";

export interface FileSnapshotEntry {
  existed: boolean;
  content?: Buffer;
}

export class FileSnapshotStore {
  private readonly snapshots = new Map<string, FileSnapshotEntry>();

  /**
   * Captures the original state of a file before its first modification in a session.
   * Subsequent edits to the same file do not overwrite the initial baseline snapshot.
   */
  recordBeforeWrite(workspaceRoot: string, pathInput: string): void {
    const target = resolve(workspaceRoot, pathInput);
    if (!isInside(workspaceRoot, target)) return;
    const rel = relative(workspaceRoot, target);
    if (this.snapshots.has(rel)) return;

    if (existsSync(target)) {
      try {
        const content = readFileSync(target);
        this.snapshots.set(rel, { existed: true, content });
      } catch {
        // Ignore unreadable directories or special files
      }
    } else {
      this.snapshots.set(rel, { existed: false });
    }
  }

  rollbackFile(workspaceRoot: string, pathInput: string): "restored" | "removed" | "untouched" {
    const target = resolve(workspaceRoot, pathInput);
    if (!isInside(workspaceRoot, target)) return "untouched";
    const rel = relative(workspaceRoot, target);
    const entry = this.snapshots.get(rel);
    if (!entry) return "untouched";

    this.snapshots.delete(rel);
    if (entry.existed && entry.content !== undefined) {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, entry.content);
      return "restored";
    }
    if (existsSync(target)) {
      rmSync(target, { force: true });
    }
    return "removed";
  }

  rollbackAll(workspaceRoot: string): { restored: string[]; removed: string[] } {
    const restored: string[] = [];
    const removed: string[] = [];
    for (const rel of [...this.snapshots.keys()]) {
      const outcome = this.rollbackFile(workspaceRoot, rel);
      if (outcome === "restored") restored.push(rel);
      else if (outcome === "removed") removed.push(rel);
    }
    return { restored: restored.sort(), removed: removed.sort() };
  }

  trackedFiles(): string[] {
    return [...this.snapshots.keys()].sort();
  }

  getBaseline(workspaceRoot: string, pathInput: string): FileSnapshotEntry | undefined {
    const target = resolve(workspaceRoot, pathInput);
    if (!isInside(workspaceRoot, target)) return undefined;
    return this.snapshots.get(relative(workspaceRoot, target));
  }

  clear(): void {
    this.snapshots.clear();
  }
}
