import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Action, Mode, PermissionDecision, PermissionTier } from "@terminus/shared";
import { isInside } from "@terminus/shared";
import defaultPolicy from "./default-policy.json";

export interface PolicyRule {
  pattern: string;
  reason: string;
}

export interface FastRule extends PolicyRule {
  tier: PermissionTier;
}

export interface Policy {
  version: string;
  name: string;
  hard_deny: PolicyRule[];
  fast_path: FastRule[];
}

const MODE_TIERS: Record<Mode, readonly PermissionTier[]> = {
  ask: ["read"],
  plan: ["read"],
  audit: ["read"],
  act: ["read", "modify"],
  auto: ["read", "modify"],
};

const SENSITIVE_FILE =
  /(?:^|\/)\.env(?!\.(example|sample|template))(\.\w+)?$|(?:^|\/)\.(ssh|aws)(\/|$)|(?:^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.\w+)?$|(?:^|\/)(\.netrc|\.git-credentials|credentials|config\.json)$/;

const allow = (tier: PermissionTier, reason: string): PermissionDecision => ({
  action: "allow",
  tier,
  reason,
});

const deny = (tier: PermissionTier, reason: string): PermissionDecision => ({
  action: "deny",
  tier,
  reason,
});

const ask = (tier: PermissionTier, reason: string): PermissionDecision => ({
  action: "ask",
  tier,
  reason,
});

const compile = (label: string, pattern: string): RegExp => {
  try {
    return new RegExp(pattern, "i");
  } catch {
    throw new Error(`invalid ${label} pattern: ${pattern}`);
  }
};

const tighten = (base: Policy, local: unknown): Policy => {
  if (local === undefined) return base;
  if (typeof local !== "object" || local === null) {
    throw new Error("local policy must be an object");
  }
  const candidate = local as { hard_deny?: unknown; fast_path?: unknown };
  if (candidate.fast_path !== undefined) {
    throw new Error("local policy may only add hard_deny rules, never fast_path rules");
  }
  if (candidate.hard_deny === undefined) return base;
  if (!Array.isArray(candidate.hard_deny)) {
    throw new Error("local policy hard_deny must be an array");
  }
  const extra = candidate.hard_deny as PolicyRule[];
  for (const rule of extra) {
    if (typeof rule?.pattern !== "string" || typeof rule?.reason !== "string") {
      throw new Error("local hard_deny rules need pattern and reason strings");
    }
    compile("local hard_deny", rule.pattern);
  }
  return { ...base, hard_deny: [...base.hard_deny, ...extra] };
};

export const loadPolicy = (localPath?: string): Policy => {
  const path = localPath ?? join(homedir(), ".terminus", "policy.local.json");
  let local: unknown;
  if (existsSync(path)) {
    local = JSON.parse(readFileSync(path, "utf8"));
  }
  const policy = tighten(defaultPolicy as Policy, local);
  for (const rule of policy.hard_deny) compile("hard_deny", rule.pattern);
  for (const rule of policy.fast_path) compile("fast_path", rule.pattern);
  return policy;
};

export class PermissionEngine {
  private readonly hardDeny: { re: RegExp; reason: string }[];
  private readonly fastPath: { re: RegExp; tier: PermissionTier; reason: string }[];

  constructor(private readonly opts: { workspaceRoot: string; mode?: Mode; policy?: Policy }) {
    const policy = opts.policy ?? loadPolicy();
    this.hardDeny = policy.hard_deny.map((rule) => ({
      re: compile("hard_deny", rule.pattern),
      reason: rule.reason,
    }));
    this.fastPath = policy.fast_path.map((rule) => ({
      re: compile("fast_path", rule.pattern),
      tier: rule.tier,
      reason: `fast path: ${rule.reason}`,
    }));
  }

  get mode(): Mode {
    return this.opts.mode ?? "act";
  }

  set mode(next: Mode) {
    this.opts.mode = next;
  }

  evaluate(action: Action): PermissionDecision {
    if (action.kind !== "command") return this.evaluateFile(action);
    return this.evaluateCommand(action.command);
  }

  private evaluateCommand(command: string): PermissionDecision {
    for (const rule of this.hardDeny) {
      if (rule.re.test(command)) return deny("high_impact", rule.reason);
    }
    const fast = this.fastPath.find((rule) => rule.re.test(command));
    if (fast) {
      return MODE_TIERS[this.mode].includes(fast.tier)
        ? allow(fast.tier, fast.reason)
        : deny(fast.tier, `mode "${this.mode}" does not permit ${fast.tier} operations`);
    }
    if (this.mode === "act" || this.mode === "auto") {
      return ask("high_impact", "unrecognized command, nothing claims it is safe");
    }
    return deny("high_impact", `mode "${this.mode}" is read-only`);
  }

  private evaluateFile(action: {
    kind: "file_read" | "file_write";
    path: string;
  }): PermissionDecision {
    const tier: PermissionTier = action.kind === "file_read" ? "read" : "modify";
    if (!isInside(this.opts.workspaceRoot, action.path)) {
      return deny(tier, "path resolves outside the workspace");
    }
    if (SENSITIVE_FILE.test(action.path)) {
      return deny(tier, "sensitive file, excluded from agent access");
    }
    if (action.kind === "file_write" && /(?:^|\/)\.git(\/|$)/.test(action.path)) {
      return deny(tier, "git internals are managed through git tools only");
    }
    return MODE_TIERS[this.mode].includes(tier)
      ? allow(tier, `workspace ${action.kind === "file_read" ? "read" : "write"}`)
      : deny(tier, `mode "${this.mode}" does not permit ${tier} operations`);
  }
}
