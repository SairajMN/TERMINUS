import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHomeEnv } from "./env";

const dirs: string[] = [];
const touched = ["NEBIUS_API_KEY", "TAVILY_API_KEY"];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of touched) saved[key] = process.env[key];
  delete process.env.NEBIUS_API_KEY;
  delete process.env.TAVILY_API_KEY;
});

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const key of touched) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("home env loading", () => {
  it("loads managed keys, ignores others, never overrides", () => {
    const dir = mkdtempSync(join(tmpdir(), "terminus-env-"));
    dirs.push(dir);
    const file = join(dir, ".env");
    writeFileSync(
      file,
      [
        "# comment",
        "NEBIUS_API_KEY=abc123",
        "TAVILY_API_KEY='tvly-xyz'",
        "UNRELATED_SECRET=nope",
        "MALFORMED line",
        "",
      ].join("\n"),
    );
    process.env.NEBIUS_API_KEY = "already-set";
    const loaded = loadHomeEnv(file);
    expect(process.env.NEBIUS_API_KEY).toBe("already-set");
    expect(process.env.TAVILY_API_KEY).toBe("tvly-xyz");
    expect(process.env.UNRELATED_SECRET).toBeUndefined();
    expect(loaded).toEqual(["TAVILY_API_KEY"]);
  });

  it("returns empty when the file is missing", () => {
    expect(loadHomeEnv(join(tmpdir(), "definitely-missing.env"))).toEqual([]);
  });
});
