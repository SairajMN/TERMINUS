import { type Dirent, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { DEFAULT_SKIP_DIRS } from "@terminus/shared";

export interface Shortcut {
  file: string;
  line: number;
  text: string;
}

const MAX_FILE_BYTES = 256_000;

export const scanShortcuts = (root: string, word = "shortcut:"): Shortcut[] => {
  const found: Shortcut[] = [];
  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".") && !DEFAULT_SKIP_DIRS.has(entry.name)) {
          walk(join(dir, entry.name));
        }
        continue;
      }
      const path = join(dir, entry.name);
      try {
        if (statSync(path).size > MAX_FILE_BYTES) continue;
        const content = readFileSync(path, "utf8");
        if (content.includes("\0")) continue;
        content.split("\n").forEach((line, index) => {
          if (line.includes(word)) {
            found.push({
              file: relative(root, path),
              line: index + 1,
              text: line.trim().slice(0, 200),
            });
          }
        });
      } catch {}
    }
  };
  walk(root);
  return found.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
};
