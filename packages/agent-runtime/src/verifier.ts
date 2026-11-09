import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { analyzeProject, extractFileSymbols } from "@terminus/context-engine";
import { scanCode } from "./sast";

export interface PostEditIssue {
  severity: "blocker" | "major" | "minor";
  code: string;
  file: string;
  line: number;
  message: string;
}

const JS_TS_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const RESOLVE_SUFFIXES = [
  "",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".json",
  ".css",
  "/index.ts",
  "/index.tsx",
  "/index.js",
  "/index.jsx",
  "/index.mjs",
];

const NODE_BUILTINS = new Set([
  "assert",
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "diagnostics_channel",
  "dns",
  "domain",
  "events",
  "fs",
  "fs/promises",
  "http",
  "http2",
  "https",
  "inspector",
  "module",
  "net",
  "os",
  "path",
  "path/posix",
  "path/win32",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "readline/promises",
  "repl",
  "stream",
  "stream/promises",
  "stream/web",
  "string_decoder",
  "sys",
  "timers",
  "timers/promises",
  "tls",
  "trace_events",
  "tty",
  "url",
  "util",
  "util/types",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
  "zlib",
]);

const resolveImportTarget = (
  workspaceRoot: string,
  fromFileFull: string,
  specifier: string,
  aliases: Record<string, string[]>,
): string | null => {
  const candidates: string[] = [];

  if (specifier.startsWith(".")) {
    candidates.push(resolve(dirname(fromFileFull), specifier));
  } else {
    for (const [pattern, targets] of Object.entries(aliases)) {
      if (pattern.endsWith("/*")) {
        const prefix = pattern.slice(0, -1); // e.g. "@/"
        if (specifier.startsWith(prefix)) {
          const rest = specifier.slice(prefix.length);
          for (const target of targets) {
            const cleanTarget = target.endsWith("/*") ? target.slice(0, -1) : target;
            candidates.push(resolve(workspaceRoot, cleanTarget, rest));
          }
        }
      } else if (specifier === pattern) {
        for (const target of targets) {
          candidates.push(resolve(workspaceRoot, target));
        }
      }
    }
  }

  for (const base of candidates) {
    for (const suffix of RESOLVE_SUFFIXES) {
      const candidate = `${base}${suffix}`;
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) {
          return candidate;
        }
      } catch {}
    }
  }
  return null;
};

const barePackageName = (specifier: string): string => {
  if (specifier.startsWith("@")) {
    const parts = specifier.split("/");
    return parts.slice(0, 2).join("/");
  }
  return specifier.split("/")[0] ?? specifier;
};

export function verifyEditedFile(workspaceRoot: string, relPath: string): PostEditIssue[] {
  const fullPath = resolve(workspaceRoot, relPath);
  if (!existsSync(fullPath)) return [];
  const ext = extname(fullPath);
  if (!JS_TS_EXTS.includes(ext)) return [];

  let content: string;
  try {
    content = readFileSync(fullPath, "utf8");
  } catch {
    return [];
  }

  const issues: PostEditIssue[] = [];
  const analysis = analyzeProject(workspaceRoot);
  const hasPkgJson = existsSync(join(workspaceRoot, "package.json"));
  const knownDeps = new Set([...analysis.dependencies, ...analysis.devDependencies]);
  const isNextAppRouter = analysis.frameworks.some((f) => f.includes("Next.js (App Router)"));

  // 1. SAST Security Checks
  for (const finding of scanCode(content, relPath)) {
    issues.push({
      severity: finding.severity,
      code: finding.ruleId,
      file: relPath,
      line: finding.line,
      message: `[${finding.category}] ${finding.message} (${finding.recommendation})`,
    });
  }

  // 2. Next.js App Router Client/Server Boundary Checks
  const syms = extractFileSymbols(content, ext);
  if (isNextAppRouter && (ext === ".tsx" || ext === ".jsx")) {
    if (!syms.hasUseClient) {
      const hookMatch = content.match(
        /\b(useState|useEffect|useReducer|useRef|useLayoutEffect|useContext|createContext)\s*\(/,
      );
      const clientLibMatch = content.match(
        /from\s+['"](framer-motion|@react-three\/fiber|@react-three\/drei)['"]/,
      );
      const trigger = hookMatch?.[1] ?? clientLibMatch?.[1];
      if (trigger) {
        issues.push({
          severity: "blocker",
          code: "NEXTJS-MISSING-USE-CLIENT",
          file: relPath,
          line: 1,
          message: `Uses client-side API "${trigger}" in a Next.js App Router component without a top-level 'use client'; directive.`,
        });
      }
    } else if (/export\s+const\s+metadata\b/.test(content)) {
      issues.push({
        severity: "blocker",
        code: "NEXTJS-CLIENT-METADATA-CONFLICT",
        file: relPath,
        line: 1,
        message: `Exports Next.js "metadata" from a component marked with 'use client'. Move metadata to a Server Component layout/page.`,
      });
    }
  }

  // 3. Static Import Resolution, Export Compatibility & Dependency Verification
  const lines = content.split("\n");
  const importRe =
    /^\s*import\s+(?:type\s+)?(?:([A-Za-z_$][\w$]*)\s*(?:,\s*\{([^}]+)\})?|\{([^}]+)\}|\*\s+as\s+[A-Za-z_$][\w$]*)?\s*(?:from\s+)?['"]([^'"]+)['"]/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!line.includes("import")) continue;
    const match = importRe.exec(line);
    if (!match) continue;

    const isTypeImport = /^\s*import\s+type\b/.test(line);
    const defaultImport = match[1]?.trim();
    const namedBlock = match[2] ?? match[3];
    const specifier = match[4]?.trim();
    if (!specifier) continue;

    const isRelative = specifier.startsWith(".");
    const isAlias = Object.keys(analysis.tsPathAliases).some((a) =>
      specifier.startsWith(a.replace(/\*$/, "")),
    );

    if (isRelative || isAlias) {
      const resolved = resolveImportTarget(
        workspaceRoot,
        fullPath,
        specifier,
        analysis.tsPathAliases,
      );
      if (!resolved) {
        issues.push({
          severity: "minor",
          code: "BROKEN-LOCAL-IMPORT",
          file: relPath,
          line: i + 1,
          message: `Cannot resolve local module "${specifier}". If you have not created "${specifier}" yet, create it in your next step; do not rewrite this file in a loop.`,
        });
        continue;
      }

      const targetExt = extname(resolved);
      if (!isTypeImport && JS_TS_EXTS.includes(targetExt)) {
        try {
          const targetContent = readFileSync(resolved, "utf8");
          const hasStarReExport = /export\s+\*\s+from/.test(targetContent);
          if (!hasStarReExport) {
            const targetSyms = extractFileSymbols(targetContent, targetExt);
            if (defaultImport && !targetSyms.defaultExport && targetSyms.namedExports.length > 0) {
              issues.push({
                severity: "blocker",
                code: "EXPORT-DEFAULT-MISMATCH",
                file: relPath,
                line: i + 1,
                message: `Module "${specifier}" does not have a default export (it exports named: { ${targetSyms.namedExports.join(", ")} }). Use a named import or add export default.`,
              });
            }
            if (namedBlock && targetSyms.namedExports.length > 0) {
              for (const rawSym of namedBlock.split(",")) {
                const sym = rawSym
                  .trim()
                  .replace(/^type\s+/, "")
                  .split(/\s+as\s+/)[0]
                  ?.trim();
                if (
                  sym &&
                  !targetSyms.namedExports.includes(sym) &&
                  targetSyms.defaultExport === sym
                ) {
                  issues.push({
                    severity: "blocker",
                    code: "EXPORT-NAMED-MISMATCH",
                    file: relPath,
                    line: i + 1,
                    message: `Module "${specifier}" exports "${sym}" as a default export, not a named export.`,
                  });
                }
              }
            }
          }
        } catch {}
      }
    } else if (hasPkgJson) {
      if (
        specifier.startsWith("node:") ||
        specifier.startsWith("bun:") ||
        specifier.startsWith("http:") ||
        specifier.startsWith("https:")
      ) {
        continue;
      }
      const pkg = barePackageName(specifier);
      if (NODE_BUILTINS.has(pkg) || NODE_BUILTINS.has(specifier)) continue;
      if (
        !knownDeps.has(pkg) &&
        !existsSync(join(workspaceRoot, "node_modules", pkg)) &&
        !pkg.startsWith("@terminus/")
      ) {
        issues.push({
          severity: "major",
          code: "MISSING-PACKAGE-DEPENDENCY",
          file: relPath,
          line: i + 1,
          message: `Package "${pkg}" is imported but not listed in package.json dependencies or installed in node_modules.`,
        });
      }
    }
  }

  return issues;
}

export function formatPostEditDiagnostics(issues: PostEditIssue[]): string {
  if (issues.length === 0) return "";
  const formatted = issues
    .map(
      (issue) =>
        `  - [${issue.severity.toUpperCase()}:${issue.code}] ${issue.file}:${issue.line} — ${issue.message}`,
    )
    .join("\n");
  return `\n\n[instant static verifier found ${issues.length} issue(s) — fix before finishing]:\n${formatted}`;
}
