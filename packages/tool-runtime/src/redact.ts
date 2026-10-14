const PATTERNS: [RegExp, string][] = [
  [/\b(sk|rk)_(live|test)_[A-Za-z0-9]{8,}/g, "[redacted-key]"],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, "[redacted-key]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[redacted-aws-key]"],
  [/\bghp_[A-Za-z0-9]{36}\b/g, "[redacted-github-token]"],
  [/\bxox[bap]-[A-Za-z0-9-]{10,}/g, "[redacted-slack-token]"],
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    "[redacted-private-key]",
  ],
];

export const redact = (text: string): string =>
  PATTERNS.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), text);
