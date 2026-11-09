import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { DEFAULT_SKIP_DIRS } from "@terminus/shared";
import { discoverSkills, matchSkills } from "./skills";

const MAX_DEPTH = 3;
const MAX_SYMBOL_FILE_BYTES = 128_000;
const MANIFESTS = ["package.json", "pyproject.toml", "Cargo.toml", "go.mod"] as const;
const CODE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
]);

export interface ProjectAnalysis {
  projectName: string;
  languages: string[];
  runtime: string;
  packageManager: string;
  frameworks: string[];
  testFramework: string | null;
  buildSystem: string | null;
  isMonorepo: boolean;
  dependencies: string[];
  devDependencies: string[];
  tsPathAliases: Record<string, string[]>;
  gitBranch: string | null;
}

export interface FileSymbols {
  defaultExport: string | null;
  namedExports: string[];
  hasUseClient: boolean;
}

export const extractFileSymbols = (content: string, ext = ".ts"): FileSymbols => {
  const hasUseClient = /^\s*['"]use client['"]\s*;?/m.test(content.slice(0, 400));
  let defaultExport: string | null = null;
  const named = new Set<string>();

  if (ext === ".py") {
    const pyMatches = content.matchAll(/^(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/gm);
    for (const m of pyMatches) {
      if (m[1] && !m[1].startsWith("_")) named.add(m[1]);
    }
    return { defaultExport: null, namedExports: [...named].slice(0, 12), hasUseClient: false };
  }

  if (ext === ".go") {
    const goMatches = content.matchAll(/^func\s+(?:\([^)]+\)\s+)?([A-Z]\w*)|^type\s+([A-Z]\w*)/gm);
    for (const m of goMatches) {
      const sym = m[1] ?? m[2];
      if (sym) named.add(sym);
    }
    return { defaultExport: null, namedExports: [...named].slice(0, 12), hasUseClient: false };
  }

  if (ext === ".rs") {
    const rsMatches = content.matchAll(
      /^\s*pub\s+(?:async\s+)?(?:fn|struct|enum|trait|type)\s+([A-Za-z_]\w*)/gm,
    );
    for (const m of rsMatches) {
      if (m[1]) named.add(m[1]);
    }
    return { defaultExport: null, namedExports: [...named].slice(0, 12), hasUseClient: false };
  }

  const defFn = content.match(
    /export\s+default\s+(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/,
  );
  if (defFn?.[1]) {
    defaultExport = defFn[1];
  } else {
    const defId = content.match(/export\s+default\s+([A-Za-z_$][\w$]*)\s*;?/);
    if (defId?.[1] && defId[1] !== "function" && defId[1] !== "class" && defId[1] !== "async") {
      defaultExport = defId[1];
    } else if (/export\s+default\s+/.test(content)) {
      defaultExport = "default";
    }
  }

  const declMatches = content.matchAll(
    /export\s+(?:declare\s+)?(?:async\s+)?(?:function|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g,
  );
  for (const match of declMatches) {
    if (match[1]) named.add(match[1]);
  }

  const listMatches = content.matchAll(/export\s+(?:type\s+)?\{([^}]+)\}/g);
  for (const match of listMatches) {
    const body = match[1];
    if (!body) continue;
    for (const part of body.split(",")) {
      const cleaned = part
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/)
        .pop()
        ?.trim();
      if (cleaned && /^[A-Za-z_$][\w$]*$/.test(cleaned)) {
        if (cleaned === "default") defaultExport = defaultExport ?? "default";
        else named.add(cleaned);
      }
    }
  }

  return {
    defaultExport,
    namedExports: [...named].slice(0, 12),
    hasUseClient,
  };
};

export const analyzeProject = (root: string): ProjectAnalysis => {
  const languages = new Set<string>();
  const frameworks = new Set<string>();
  let projectName = root.split(/[\\/]/).pop() || "workspace";
  let runtime = "Node.js";
  let packageManager = "npm";
  let testFramework: string | null = null;
  let buildSystem: string | null = null;
  let isMonorepo = false;
  let dependencies: string[] = [];
  let devDependencies: string[] = [];
  const tsPathAliases: Record<string, string[]> = {};
  let gitBranch: string | null = null;

  if (existsSync(join(root, "bun.lock")) || existsSync(join(root, "bun.lockb"))) {
    packageManager = "bun";
    runtime = "Bun";
  } else if (
    existsSync(join(root, "pnpm-lock.yaml")) ||
    existsSync(join(root, "pnpm-workspace.yaml"))
  ) {
    packageManager = "pnpm";
  } else if (existsSync(join(root, "yarn.lock"))) {
    packageManager = "yarn";
  }

  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      name?: string;
      workspaces?: unknown;
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    if (pkg.name) projectName = pkg.name;
    if (pkg.workspaces) isMonorepo = true;
    dependencies = Object.keys(pkg.dependencies ?? {});
    devDependencies = Object.keys(pkg.devDependencies ?? {});
    const allDeps = new Set([...dependencies, ...devDependencies]);
    const scripts = pkg.scripts ?? {};

    if (allDeps.has("typescript") || existsSync(join(root, "tsconfig.json"))) {
      languages.add("TypeScript");
    } else {
      languages.add("JavaScript");
    }

    if (allDeps.has("next")) {
      const hasAppRouter = existsSync(join(root, "src", "app")) || existsSync(join(root, "app"));
      frameworks.add(hasAppRouter ? "Next.js (App Router)" : "Next.js");
      buildSystem = "Next.js";
    }
    if (allDeps.has("react")) frameworks.add("React");
    if (allDeps.has("vue")) frameworks.add("Vue");
    if (allDeps.has("svelte")) frameworks.add("Svelte");
    if (allDeps.has("express")) frameworks.add("Express");
    if (allDeps.has("fastify")) frameworks.add("Fastify");
    if (allDeps.has("tailwindcss")) frameworks.add("Tailwind CSS");
    if (allDeps.has("three") || allDeps.has("@react-three/fiber")) frameworks.add("Three.js");
    if (allDeps.has("prisma") || allDeps.has("@prisma/client")) frameworks.add("Prisma");

    if (allDeps.has("vitest") || scripts.test?.includes("vitest")) testFramework = "Vitest";
    else if (allDeps.has("jest") || scripts.test?.includes("jest")) testFramework = "Jest";
    else if (scripts.test?.includes("bun test")) testFramework = "Bun Test";
    else if (scripts.test?.includes("node")) testFramework = "Node Test";

    if (!buildSystem) {
      if (allDeps.has("vite")) buildSystem = "Vite";
      else if (allDeps.has("turbo")) buildSystem = "Turborepo";
      else if (scripts.build?.includes("tsc")) buildSystem = "tsc";
    }
  } catch {}

  if (existsSync(join(root, "pyproject.toml")) || existsSync(join(root, "requirements.txt"))) {
    languages.add("Python");
    runtime = "Python";
    testFramework = testFramework ?? "pytest";
  }
  if (existsSync(join(root, "Cargo.toml"))) {
    languages.add("Rust");
    runtime = "Rust";
    packageManager = "cargo";
  }
  if (existsSync(join(root, "go.mod"))) {
    languages.add("Go");
    runtime = "Go";
    packageManager = "go";
  }

  for (const tsName of ["tsconfig.json", "tsconfig.base.json"]) {
    try {
      const raw = readFileSync(join(root, tsName), "utf8");
      const stripped = raw.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      const parsed = JSON.parse(stripped) as {
        compilerOptions?: { paths?: Record<string, string[]> };
      };
      const paths = parsed.compilerOptions?.paths;
      if (paths && typeof paths === "object") {
        for (const [alias, targets] of Object.entries(paths)) {
          if (Array.isArray(targets)) {
            tsPathAliases[alias] = targets.map(String);
          }
        }
      }
    } catch {}
  }

  try {
    const head = readFileSync(join(root, ".git", "HEAD"), "utf8").trim();
    if (head.startsWith("ref: refs/heads/")) {
      gitBranch = head.slice("ref: refs/heads/".length);
    }
  } catch {}

  return {
    projectName,
    languages: [...languages],
    runtime,
    packageManager,
    frameworks: [...frameworks],
    testFramework,
    buildSystem,
    isMonorepo,
    dependencies,
    devDependencies,
    tsPathAliases,
    gitBranch,
  };
};

const summarizeManifest = (root: string, name: string): string | null => {
  if (name !== "package.json") return name;
  try {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      name?: string;
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const scripts = Object.keys(manifest.scripts ?? {}).join(", ");
    const deps = Object.keys(manifest.dependencies ?? {});
    const devDeps = Object.keys(manifest.devDependencies ?? {});
    const depNote = deps.length > 0 ? ` deps: ${deps.slice(0, 20).join(", ")}` : "";
    const devDepNote = devDeps.length > 0 ? ` devDeps: ${devDeps.slice(0, 15).join(", ")}` : "";
    return `package.json${manifest.name ? ` (${manifest.name})` : ""}${scripts ? ` scripts: ${scripts}` : ""}${depNote}${devDepNote}`;
  } catch {
    return "package.json (unreadable)";
  }
};

const formatSymbolHint = (filePath: string): string => {
  const ext = extname(filePath);
  if (!CODE_EXTENSIONS.has(ext)) return "";
  try {
    const st = statSync(filePath);
    if (st.size > MAX_SYMBOL_FILE_BYTES || st.size === 0) return "";
    const content = readFileSync(filePath, "utf8");
    const syms = extractFileSymbols(content, ext);
    const parts: string[] = [];
    if (syms.hasUseClient) parts.push("'use client'");
    if (syms.defaultExport) parts.push(`default:${syms.defaultExport}`);
    if (syms.namedExports.length > 0) parts.push(`exports:{${syms.namedExports.join(",")}}`);
    return parts.length > 0 ? `  [${parts.join(" ")}]` : "";
  } catch {
    return "";
  }
};

export const buildRepoMap = (root: string): string => {
  const lines: string[] = ["repository layout:"];

  const render = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries
      .filter((entry) => !entry.name.startsWith(".") && !DEFAULT_SKIP_DIRS.has(entry.name))
      .sort(
        (a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name),
      )
      .forEach((entry) => {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          lines.push(`${"  ".repeat(depth)}${entry.name}/`);
          render(fullPath, depth + 1);
        } else {
          const hint = formatSymbolHint(fullPath);
          lines.push(`${"  ".repeat(depth)}${entry.name}${hint}`);
        }
      });
  };
  render(root, 0);

  const summaries = MANIFESTS.map((name) => {
    try {
      readFileSync(join(root, name));
    } catch {
      return null;
    }
    return summarizeManifest(root, name);
  }).filter((line): line is string => line !== null);
  if (summaries.length > 0) {
    lines.push("", "manifests:");
    for (const summary of summaries) lines.push(`  ${summary}`);
  }

  const analysis = analyzeProject(root);
  const metaLines: string[] = [];
  if (analysis.frameworks.length > 0) {
    metaLines.push(`  frameworks: ${analysis.frameworks.join(", ")}`);
  }
  const aliasEntries = Object.entries(analysis.tsPathAliases);
  if (aliasEntries.length > 0) {
    metaLines.push(
      `  tsconfig paths: ${aliasEntries.map(([k, v]) => `${k} -> ${v.join(" | ")}`).join(", ")}`,
    );
  }
  if (metaLines.length > 0) {
    lines.push("", "project intelligence:", ...metaLines);
  }

  return lines.join("\n");
};

const INSTRUCTION_FILES = [
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  "TERMINUS.md",
  ".terminus/instructions.md",
] as const;

export const loadInstructions = (root: string, task?: string): string | null => {
  const loadedBlocks: string[] = [];
  for (const name of INSTRUCTION_FILES) {
    try {
      const content = readFileSync(join(root, name), "utf8").trim();
      if (content.length > 0) {
        loadedBlocks.push(content);
        break;
      }
    } catch {}
  }

  if (task) {
    try {
      const skillsDir = join(root, "skills");
      const discovered = existsSync(skillsDir) ? discoverSkills(skillsDir) : [];

      // Also discover bundled skills from TERMINUS package root so they are always available
      const bundledCandidates = [
        resolve(__dirname, "../../../skills"),
        resolve(__dirname, "../../skills"),
        resolve(__dirname, "../skills"),
      ];
      for (const candidate of bundledCandidates) {
        if (candidate !== skillsDir && existsSync(candidate)) {
          const bundled = discoverSkills(candidate);
          // Only add skills not already overridden by workspace
          const existingNames = new Set(discovered.map((s) => s.name));
          for (const s of bundled) {
            if (!existingNames.has(s.name)) {
              discovered.push(s);
              existingNames.add(s.name);
            }
          }
          break;
        }
      }

      const matched = matchSkills(task, discovered);
      if (matched.length > 0 && matched[0]) {
        const top = matched[0];
        const skillBlock = `[Active Skill: ${top.name}]\n${top.content}`;
        loadedBlocks.push(skillBlock);
      }
    } catch {}
  }

  return loadedBlocks.length > 0 ? loadedBlocks.join("\n\n") : null;
};
