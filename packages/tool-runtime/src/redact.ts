const PATTERNS: [RegExp, string][] = [
  [/\b(sk|rk)_(live|test)_[A-Za-z0-9]{8,}/g, "[redacted-key]"],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, "[redacted-key]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[redacted-aws-key]"],
  [/\bgh[pous]_[A-Za-z0-9]{36,}\b/g, "[redacted-github-token]"],
  [/\bgithub_pat_[A-Za-z0-9_]{82}\b/g, "[redacted-github-token]"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, "[redacted-slack-token]"],
  [/\beyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/g, "[redacted-jwt]"],
  [/https?:\/\/[^\s/@:]+:[^\s/@]+@[^\s/]+/g, "[redacted-url-credentials]"],
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    "[redacted-private-key]",
  ],
];

export const redact = (text: string): string =>
  PATTERNS.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), text);
