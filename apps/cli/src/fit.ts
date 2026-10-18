import { homedir } from "node:os";

const clamp = (value: number, low: number, high: number): number =>
  Math.min(high, Math.max(low, value));

const envNumber = (name: string): number | undefined => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
};

export const fitWidth = (raw?: number): number =>
  clamp(Math.floor(raw ?? envNumber("COLUMNS") ?? 80), 40, 200);

export const fitHeight = (raw?: number): number =>
  clamp(Math.floor(raw ?? envNumber("LINES") ?? 24), 10, 120);

export const clip = (text: string, width: number): string => {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  if (width === 1) return "…";
  return `${text.slice(0, width - 1)}…`;
};

export const wrap = (text: string, width: number): string[] => {
  const limit = Math.max(8, width);
  const lines: string[] = [];
  let current = "";
  for (const raw of text.split(/\s+/)) {
    if (raw.length === 0) continue;
    const word = raw.length > limit ? clip(raw, limit) : raw;
    if (current.length === 0) current = word;
    else if (current.length + 1 + word.length <= limit) current = `${current} ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines.length > 0 ? lines : [""];
};

export const shortPath = (path: string, width: number, home = homedir()): string => {
  if (width <= 0) return "";
  if (path.length <= width) return path;
  const tilde = home.length > 0 && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
  if (tilde.length <= width) return tilde;
  const parts = tilde.split("/").filter((part) => part.length > 0);
  for (let keep = 1; keep <= parts.length; keep++) {
    const tail = parts.slice(parts.length - keep).join("/");
    const candidate = `…/${tail}`;
    if (candidate.length <= width) return candidate;
  }
  return clip(tilde, width);
};
