import { createHmac, timingSafeEqual } from "node:crypto";
import { sharedTargetLimiter } from "@terminus/tool-runtime";
import type { EvidenceLedger } from "../ledger";
import type { AttackExecutionResult } from "./types";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const COMMON_WEAK_JWT_SECRETS = [
  "secret",
  "password",
  "key",
  "123456",
  "admin",
  "test",
  "jwt_secret",
  "changeme",
  "supersecret",
  "default",
  "qwerty",
  "letmein",
  "jwt",
  "token",
  "dev-secret",
  "",
];

const SSTI_A = 7919;
const SSTI_B = 6841;
const SSTI_PRODUCT = String(SSTI_A * SSTI_B); // "54173879"

const SQL_ERROR_PATTERNS = [
  /SQLITE_ERROR/i,
  /SQL syntax.*MySQL/i,
  /You have an error in your SQL syntax/i,
  /unterminated quoted string/i,
  /PG::SyntaxError/i,
  /syntax error at or near/i,
  /ORA-\d{4,5}/i,
  /SQLSTATE\[/i,
];

export interface DastRouteSpec {
  path: string;
  param?: string;
  method?: "GET" | "POST";
  jwtToken?: string;
}

export interface JwtWeakness {
  title: string;
  severity: "critical" | "high" | "medium" | "low";
  detail: string;
}

export interface DastProbeOutcome {
  vulnerable: boolean;
  classification: "exploited" | "escaped" | "blocked" | "clean";
  status: number;
  indicator: string;
  url: string;
  method: string;
}

/**
 * Validates that a target URL resolves strictly to loopback (fail-closed).
 * External hosts and private LAN ranges are unconditionally refused.
 */
export function assertLoopbackTarget(rawUrl: string): URL {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported DAST protocol "${parsed.protocol}"; only http/https allowed`);
  }
  const host = parsed.hostname.toLowerCase();
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `Fail-closed DAST scope block: target host "${parsed.hostname}" is not loopback`,
    );
  }
  return parsed;
}

function buildProbeUrl(baseUrl: string, path: string, param: string, payload: string): URL {
  const url = assertLoopbackTarget(new URL(path, baseUrl).toString());
  url.searchParams.set(param, payload);
  return url;
}

function escapeHtmlSnippet(input: string): string {
  return input.replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Pure local cryptographic audit of JWT headers, claims, and weak HMAC keys.
 */
export function analyzeJwtToken(token: string): JwtWeakness[] {
  const weaknesses: JwtWeakness[] = [];
  const parts = token.split(".");
  if (parts.length !== 3) {
    weaknesses.push({
      title: "Malformed JWT structure",
      severity: "low",
      detail: `Expected 3 dot-separated segments, found ${parts.length}.`,
    });
    return weaknesses;
  }

  const headerB64 = parts[0] ?? "";
  const payloadB64 = parts[1] ?? "";
  const sigB64 = parts[2] ?? "";

  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    weaknesses.push({
      title: "Unparseable JWT JSON payload",
      severity: "low",
      detail: "Header or payload is not valid base64url JSON.",
    });
    return weaknesses;
  }

  const alg = typeof header.alg === "string" ? header.alg : "";
  if (alg.toLowerCase() === "none" || sigB64.length === 0) {
    weaknesses.push({
      title: "JWT accepts unsigned 'none' algorithm",
      severity: "critical",
      detail: `Header alg="${alg}", signature length=${sigB64.length}.`,
    });
  }

  if (typeof payload.exp !== "number") {
    weaknesses.push({
      title: "JWT missing expiration (exp) claim",
      severity: "medium",
      detail: "Token does not expire automatically.",
    });
  }

  const shaAlg =
    alg === "HS256" ? "sha256" : alg === "HS384" ? "sha384" : alg === "HS512" ? "sha512" : null;
  if (shaAlg && sigB64.length > 0) {
    const signingInput = `${headerB64}.${payloadB64}`;
    const actualBuf = Buffer.from(sigB64, "base64url");
    for (const secret of COMMON_WEAK_JWT_SECRETS) {
      const candidateSig = createHmac(shaAlg, secret).update(signingInput).digest();
      if (candidateSig.length === actualBuf.length && timingSafeEqual(candidateSig, actualBuf)) {
        weaknesses.push({
          title: `JWT signed with weak/default HMAC secret`,
          severity: "critical",
          detail: `Verified HS* signature locally using common secret "${secret || "<empty>"}".`,
        });
        break;
      }
    }
  }

  return weaknesses;
}

/**
 * Native Loopback DAST Prober executing non-destructive HTTP probes inside
 * a keyed per-target concurrency semaphore.
 */
export class LoopbackDastProber {
  constructor(private readonly timeoutMs = 4000) {}

  private async fetchBounded(targetUrl: URL, init?: RequestInit): Promise<Response> {
    const hostKey = `${targetUrl.hostname}:${targetUrl.port || (targetUrl.protocol === "https:" ? "443" : "80")}`;
    return sharedTargetLimiter.run(hostKey, async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        return await fetch(targetUrl.toString(), {
          ...init,
          signal: controller.signal,
          redirect: "manual",
        });
      } finally {
        clearTimeout(timer);
      }
    });
  }

  async probeXss(baseUrl: string, routePath: string, param = "q"): Promise<DastProbeOutcome> {
    const nonce = `trmnst_${Math.random().toString(36).slice(2, 10)}`;
    const payload = `<${nonce}>`;
    const url = buildProbeUrl(baseUrl, routePath, param, payload);
    const res = await this.fetchBounded(url);
    const body = await res.text();
    const contentType = (res.headers.get("content-type") ?? "").toLowerCase();

    if (res.status === 403 || res.status === 406) {
      return {
        vulnerable: false,
        classification: "blocked",
        status: res.status,
        indicator: `HTTP ${res.status} security filter rejected XSS probe`,
        url: url.toString(),
        method: "GET",
      };
    }

    const isHtmlLike = contentType.includes("text/html") || contentType === "";
    if (isHtmlLike && body.includes(payload)) {
      return {
        vulnerable: true,
        classification: "exploited",
        status: res.status,
        indicator: `Unescaped HTML reflection of ${payload} (content-type=${contentType || "none"})`,
        url: url.toString(),
        method: "GET",
      };
    }

    if (body.includes(escapeHtmlSnippet(payload))) {
      return {
        vulnerable: false,
        classification: "escaped",
        status: res.status,
        indicator: "Payload reflected safely HTML-escaped",
        url: url.toString(),
        method: "GET",
      };
    }

    return {
      vulnerable: false,
      classification: "clean",
      status: res.status,
      indicator: "Nonce not reflected unescaped",
      url: url.toString(),
      method: "GET",
    };
  }

  async probeSsti(baseUrl: string, routePath: string, param = "q"): Promise<DastProbeOutcome> {
    const expressions = [
      `{{${SSTI_A}*${SSTI_B}}}`,
      `\${${SSTI_A}*${SSTI_B}}`,
      `<%= ${SSTI_A}*${SSTI_B} %>`,
    ];

    for (const expr of expressions) {
      const url = buildProbeUrl(baseUrl, routePath, param, expr);
      const res = await this.fetchBounded(url);
      const body = await res.text();
      if (body.includes(SSTI_PRODUCT) && !body.includes(expr)) {
        return {
          vulnerable: true,
          classification: "exploited",
          status: res.status,
          indicator: `Template evaluated ${expr} -> ${SSTI_PRODUCT}`,
          url: url.toString(),
          method: "GET",
        };
      }
    }

    return {
      vulnerable: false,
      classification: "clean",
      status: 200,
      indicator: "Template math marker not evaluated",
      url: buildProbeUrl(baseUrl, routePath, param, expressions[0] ?? "").toString(),
      method: "GET",
    };
  }

  async probeSqli(baseUrl: string, routePath: string, param = "q"): Promise<DastProbeOutcome> {
    const payload = `' OR '1'='1`;
    const url = buildProbeUrl(baseUrl, routePath, param, payload);
    const res = await this.fetchBounded(url);
    const body = await res.text();

    for (const pattern of SQL_ERROR_PATTERNS) {
      if (pattern.test(body)) {
        return {
          vulnerable: true,
          classification: "exploited",
          status: res.status,
          indicator: `SQL parser error signature matched (${pattern.source})`,
          url: url.toString(),
          method: "GET",
        };
      }
    }

    if (res.status >= 500) {
      return {
        vulnerable: true,
        classification: "exploited",
        status: res.status,
        indicator: `Unhandled HTTP ${res.status} server fault triggered by SQL quote probe`,
        url: url.toString(),
        method: "GET",
      };
    }

    return {
      vulnerable: false,
      classification: "clean",
      status: res.status,
      indicator: `No SQL parser errors (HTTP ${res.status})`,
      url: url.toString(),
      method: "GET",
    };
  }

  async runEndpointSweep(
    baseUrl: string,
    routes: readonly DastRouteSpec[] = [{ path: "/", param: "q" }],
    ledger?: EvidenceLedger,
  ): Promise<AttackExecutionResult[]> {
    assertLoopbackTarget(baseUrl);
    const results: AttackExecutionResult[] = [];
    let seq = 0;

    for (const route of routes) {
      const param = route.param ?? "q";
      const targetEndpoint = new URL(route.path, baseUrl).toString();

      const probes: Array<{
        category: AttackExecutionResult["category"];
        label: string;
        fn: () => Promise<DastProbeOutcome>;
      }> = [
        {
          category: "A05_INJECTION",
          label: "XSS",
          fn: () => this.probeXss(baseUrl, route.path, param),
        },
        {
          category: "A05_INJECTION",
          label: "SSTI",
          fn: () => this.probeSsti(baseUrl, route.path, param),
        },
        {
          category: "A05_INJECTION",
          label: "SQLi",
          fn: () => this.probeSqli(baseUrl, route.path, param),
        },
      ];

      for (const probe of probes) {
        const attemptedAt = Date.now();
        const hypId = `DAST-${++seq}-${probe.label}`;
        try {
          const out = await probe.fn();
          const rec = ledger?.append({
            kind: "CMD_RUN",
            agentId: "red-team-dast",
            subject: `${probe.label}:${targetEndpoint}`,
            passed: !out.vulnerable,
            exitCode: out.vulnerable ? 1 : 0,
            summary: `DAST ${probe.label} on ${route.path}: ${out.classification.toUpperCase()}`,
            rawOutput: `${out.method} ${out.url} -> HTTP ${out.status}\n${out.indicator}`,
          });

          results.push({
            hypothesisId: hypId,
            category: probe.category,
            attemptedAt,
            payload: out.url,
            outcome: out.vulnerable ? "exploited" : "blocked",
            prohibitedEffectAchieved: out.vulnerable,
            observedExecutionTrace: out.indicator,
            reproductionScript: `curl -i "${out.url}"`,
            evidenceRecordId: rec?.id,
            httpTrace: {
              url: out.url,
              method: out.method,
              status: out.status,
              indicator: out.indicator,
            },
            confidence: out.vulnerable ? 0.95 : 0.9,
            targetEndpoint,
            explanation: out.vulnerable
              ? `VULNERABILITY: DAST ${probe.label} probe exploited ${route.path} (${out.indicator}).`
              : `DEFENSE VERIFIED: DAST ${probe.label} probe on ${route.path} did not exploit (${out.classification}).`,
          });
        } catch (err) {
          results.push({
            hypothesisId: hypId,
            category: probe.category,
            attemptedAt,
            payload: targetEndpoint,
            outcome: "error",
            prohibitedEffectAchieved: false,
            observedExecutionTrace: err instanceof Error ? err.message : String(err),
            reproductionScript: `# Probe error for ${targetEndpoint}`,
            targetEndpoint,
            explanation: `DAST ${probe.label} error on ${route.path}: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }

      if (route.jwtToken) {
        const attemptedAt = Date.now();
        const hypId = `DAST-${++seq}-JWT`;
        const weaknesses = analyzeJwtToken(route.jwtToken);
        const severe = weaknesses.some((w) => w.severity === "critical" || w.severity === "high");
        const summaryText = weaknesses
          .map((w) => `[${w.severity}] ${w.title}: ${w.detail}`)
          .join("\n");
        const rec = ledger?.append({
          kind: "SAST_SCAN",
          agentId: "red-team-dast",
          subject: `JWT:${targetEndpoint}`,
          passed: !severe,
          summary: `JWT inspection on ${route.path}: ${weaknesses.length} issue(s)`,
          rawOutput: summaryText || "JWT verified clean.",
        });

        results.push({
          hypothesisId: hypId,
          category: "A07_AUTHENTICATION_FAILURES",
          attemptedAt,
          payload: "<redacted-jwt>",
          outcome: severe ? "exploited" : "blocked",
          prohibitedEffectAchieved: severe,
          observedExecutionTrace:
            summaryText || "Strong signing algorithm and expiration verified.",
          reproductionScript: `# Inspect JWT issued by ${targetEndpoint}`,
          evidenceRecordId: rec?.id,
          confidence: severe ? 1.0 : 0.9,
          targetEndpoint,
          explanation: severe
            ? `VULNERABILITY: Weak JWT configuration detected on ${route.path}: ${weaknesses[0]?.title}`
            : `DEFENSE VERIFIED: JWT on ${route.path} passed cryptographic checks.`,
        });
      }
    }

    return results;
  }
}
