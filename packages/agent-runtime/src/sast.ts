import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface SastFinding {
  severity: "blocker" | "major" | "minor";
  category: string;
  ruleId: string;
  file: string;
  line: number;
  snippet: string;
  message: string;
  recommendation: string;
}

interface SastRule {
  id: string;
  category: string;
  severity: "blocker" | "major" | "minor";
  message: string;
  recommendation: string;
  matcher: RegExp;
  fileFilter?: (file: string) => boolean;
}

export const SAST_RULES: SastRule[] = [
  {
    id: "OWASP-A03-COMMAND-INJECTION",
    category: "OWASP A03: Injection",
    severity: "blocker",
    message: "Dynamic code execution or command evaluation detected (eval / Function / exec).",
    recommendation: "Avoid eval/exec with untrusted input; use parameterized APIs or safe parsers.",
    matcher: /\b(eval\s*\(|new\s+Function\s*\(|child_process\.(exec|execSync)\s*\()/g,
  },
  {
    id: "OWASP-A03-SQL-INJECTION",
    category: "OWASP A03: Injection",
    severity: "blocker",
    message: "Potential SQL injection: string template or concatenation inside database query.",
    recommendation: "Use parameterized queries ($1, ?), prepared statements, or an ORM.",
    matcher: /\b(query|execute|raw|all|run)\s*\(\s*`[^`]*\$\{[^}]+\}[^`]*`/g,
  },
  {
    id: "OWASP-A03-NOSQL-INJECTION",
    category: "OWASP A03: Injection (NoSQL)",
    severity: "blocker",
    message: "Potential NoSQL injection via $where operator or unsanitized query object.",
    recommendation: "Avoid $where JavaScript evaluation; validate query parameters with Zod.",
    matcher: /(\$where\s*:|\.\s*find\s*\(\s*req\.(body|query)\s*\))/g,
  },
  {
    id: "OWASP-A01-PATH-TRAVERSAL",
    category: "OWASP A01: Broken Access Control",
    severity: "blocker",
    message: "Potential path traversal: user request input passed directly into filesystem API.",
    recommendation:
      "Validate path containment with path.resolve and a workspace root prefix check.",
    matcher:
      /\b(readFile|readFileSync|writeFile|writeFileSync|unlink|unlinkSync|createReadStream)\s*\([^)]*req\.(query|params|body)/g,
  },
  {
    id: "OWASP-A01-OPEN-REDIRECT",
    category: "OWASP A01: Broken Access Control",
    severity: "major",
    message: "Unvalidated redirect using user-controlled request parameters.",
    recommendation: "Validate redirect targets against an explicit allowlist of relative paths.",
    matcher: /\bres\.redirect\s*\(\s*req\.(query|params|body)\b/g,
  },
  {
    id: "OWASP-A01-INSECURE-CORS",
    category: "OWASP A01: Broken Access Control",
    severity: "minor",
    message: "Wildcard CORS origin header configured.",
    recommendation:
      "Restrict Access-Control-Allow-Origin to trusted origins when handling credentials.",
    matcher: /['"]Access-Control-Allow-Origin['"]\s*,\s*['"]\*['"]/g,
  },
  {
    id: "OWASP-A02-HARDCODED-PRIVATE-KEY",
    category: "OWASP A02: Cryptographic Failures",
    severity: "blocker",
    message: "Hardcoded private cryptographic key material found in source.",
    recommendation: "Store private keys in environment variables or a secret vault.",
    matcher: /-----BEGIN\s+([A-Z0-9_-]+\s+)?PRIVATE\s+KEY/g,
  },
  {
    id: "OWASP-A02-HARDCODED-SECRET",
    category: "OWASP A02: Cryptographic Failures",
    severity: "major",
    message: "Potential hardcoded plaintext secret or API key token in source.",
    recommendation: "Extract credentials into environment variables or secrets manager.",
    matcher:
      /(api_key|apiKey|secret_key|secretToken|db_password)\s*[:=]\s*["'][a-zA-Z0-9_.-]{12,}["']/gi,
  },
  {
    id: "OWASP-A02-WEAK-CRYPTO-HASH",
    category: "OWASP A02: Cryptographic Failures",
    severity: "major",
    message: "Weak cryptographic hash algorithm (MD5 or SHA-1) detected.",
    recommendation: "Use SHA-256/SHA-512 for integrity or Argon2id/bcrypt/scrypt for passwords.",
    matcher: /\b(createHash\s*\(\s*['"](md5|sha1)['"]\)|hashlib\.(md5|sha1)\s*\()/gi,
  },
  {
    id: "OWASP-A02-INSECURE-RANDOM",
    category: "OWASP A02: Cryptographic Failures",
    severity: "major",
    message: "Predictable Math.random() used for security-sensitive token, secret, or session ID.",
    recommendation: "Use crypto.randomUUID() or crypto.randomBytes() for security tokens.",
    matcher:
      /\b(token|secret|nonce|otp|sessionId|password|apiKey)\w*\s*[:=][^;\n]*\bMath\.random\s*\(\)/gi,
  },
  {
    id: "OWASP-A03-XSS-INNER-HTML",
    category: "OWASP A03: Injection (XSS)",
    severity: "major",
    message:
      "Direct DOM HTML injection without sanitization (dangerouslySetInnerHTML / innerHTML).",
    recommendation: "Use textContent, safe React JSX children, or sanitize using DOMPurify.",
    matcher: /(dangerouslySetInnerHTML\s*=\s*\{\s*\{?\s*__html:|\.innerHTML\s*=)/g,
  },
  {
    id: "OWASP-A05-TLS-DISABLED",
    category: "OWASP A05: Security Misconfiguration",
    severity: "blocker",
    message: "TLS certificate verification explicitly disabled.",
    recommendation:
      "Never disable TLS verification (rejectUnauthorized: false) in production code.",
    matcher: /(NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]0['"]|rejectUnauthorized\s*:\s*false)/g,
  },
  {
    id: "OWASP-A07-JWT-NONE-ALG",
    category: "OWASP A07: Identification and Authentication Failures",
    severity: "blocker",
    message: "Insecure JWT configuration allowing 'none' algorithm.",
    recommendation: "Enforce explicit cryptographic signing algorithms (e.g. HS256, RS256, EdDSA).",
    matcher: /algorithms\s*:\s*\[[^\]]*['"]none['"][^\]]*\]/gi,
  },
  {
    id: "OWASP-A08-INSECURE-DESERIALIZATION",
    category: "OWASP A08: Software and Data Integrity Failures",
    severity: "major",
    message: "Insecure deserialization of arbitrary objects (unserialize / unsafe YAML).",
    recommendation:
      "Use JSON.parse or strict YAML schema validation (yaml.load with schema: FAILSAFE).",
    matcher: /\b(unserialize\s*\(|yaml\.load\s*\([^,)]+\)|pickle\.loads\s*\()/g,
  },
  {
    id: "OWASP-A08-PROTOTYPE-POLLUTION",
    category: "OWASP A08: Software and Data Integrity Failures",
    severity: "major",
    message: "Direct mutation of __proto__ or constructor.prototype detected.",
    recommendation: "Use Object.create(null) or Map, and block __proto__/constructor keys.",
    matcher: /(\.__proto__\s*=|\[\s*['"]__proto__['"]\s*\]\s*=)/g,
  },
  {
    id: "OWASP-A10-SSRF",
    category: "OWASP A10: Server-Side Request Forgery",
    severity: "major",
    message: "Potential SSRF: unvalidated user request parameter passed directly to fetch/axios.",
    recommendation: "Validate URL hostnames against an allowlist and block private IP ranges.",
    matcher: /\b(fetch|axios\.(get|post|request))\s*\(\s*req\.(query|params|body)\b/g,
  },
];

export function scanCode(content: string, file: string): SastFinding[] {
  const findings: SastFinding[] = [];
  const lines = content.split("\n");

  for (const rule of SAST_RULES) {
    if (rule.fileFilter && !rule.fileFilter(file)) continue;

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex];
      if (line === undefined) continue;

      rule.matcher.lastIndex = 0;
      const match = rule.matcher.exec(line);
      if (match) {
        findings.push({
          severity: rule.severity,
          category: rule.category,
          ruleId: rule.id,
          file,
          line: lineIndex + 1,
          snippet: line.trim(),
          message: rule.message,
          recommendation: rule.recommendation,
        });
      }
    }
  }

  return findings;
}

export function scanFiles(files: string[], workspaceRoot: string): SastFinding[] {
  const findings: SastFinding[] = [];
  for (const file of files) {
    const fullPath = join(workspaceRoot, file);
    if (!existsSync(fullPath)) continue;
    try {
      const content = readFileSync(fullPath, "utf8");
      findings.push(...scanCode(content, file));
    } catch {
      // Ignore unreadable or binary files
    }
  }
  return findings;
}
