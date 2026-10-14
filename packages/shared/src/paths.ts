import { realpathSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

export const isInside = (root: string, target: string): boolean => {
  const realRoot = realpathSync(root);
  let path = resolve(realRoot, target);
  for (let current = path; ; current = dirname(current)) {
    try {
      path = realpathSync(current);
      break;
    } catch {
      if (dirname(current) === current) break;
    }
  }
  return path === realRoot || path.startsWith(realRoot + sep);
};

export const DEFAULT_SKIP_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  ".cache",
  "vendor",
  "__pycache__",
  ".venv",
  ".turbo",
  ".DS_Store",
]);
