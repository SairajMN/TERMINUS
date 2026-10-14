import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRepoMap, EvidenceStore, loadInstructions } from "./index";

const root = mkdtempSync(join(tmpdir(), "terminus-context-"));
mkdirSync(join(root, "src"));
mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
mkdirSync(join(root, ".git"));
writeFileSync(join(root, "src", "main.ts"), "console.log(1);\n");
writeFileSync(join(root, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
writeFileSync(
  join(root, "package.json"),
  JSON.stringify({ name: "fixture", scripts: { test: "bun test", build: "tsc" } }),
);

describe("evidence store", () => {
  it("records provenance and hashes", () => {
    const store = new EvidenceStore();
    const item = store.add({ kind: "source", source: "src/a.ts", content: "const x = 1;" });
    expect(item.contentHash).toHaveLength(64);
    expect(item.trustLevel).toBe("untrusted");
    expect(store.get(item.id)?.source).toBe("src/a.ts");
  });

  it("ranks instructions above everything and respects the budget", () => {
    const store = new EvidenceStore();
    store.add({ kind: "source", source: "a.ts", content: "x".repeat(500) });
    store.add({ kind: "source", source: "b.ts", content: "y".repeat(500), relevance: 0.9 });
    store.add({
      kind: "instruction",
      source: "AGENTS.md",
      content: "always run lint",
      trustLevel: "trusted",
    });
    const picked = store.select({ maxChars: 600 });
    expect(picked[0]?.kind).toBe("instruction");
    expect(picked.length).toBeLessThan(3);
  });

  it("drops stale evidence from selection", () => {
    const store = new EvidenceStore();
    const item = store.add({ kind: "terminal", source: "log", content: "old output" });
    store.markStale(item.id);
    expect(store.select({ maxChars: 1000 })).toHaveLength(0);
  });

  it("detects files changed outside the agent", () => {
    const store = new EvidenceStore();
    const file = join(root, "src", "main.ts");
    store.recordRead(root, file, "console.log(1);\n");
    expect(store.checkFresh(root, file)).toBe("fresh");
    writeFileSync(file, "console.log(2);\n");
    expect(store.checkFresh(root, file)).toBe("stale");
    expect(store.checkFresh(root, join(root, "src", "unknown.ts"))).toBe("unknown");
  });

  it("boosts items matching the current focus", () => {
    const store = new EvidenceStore();
    store.add({ kind: "source", source: "auth/session.ts", content: "session code" });
    store.add({ kind: "source", source: "ui/button.tsx", content: "button code" });
    const picked = store.select({ maxChars: 1000, focus: "auth" });
    expect(picked[0]?.source).toBe("auth/session.ts");
  });
});

describe("repository map", () => {
  it("skips vendored and hidden directories", () => {
    const map = buildRepoMap(root);
    expect(map).toContain("src/");
    expect(map).toContain("main.ts");
    expect(map).not.toContain("node_modules");
    expect(map).not.toContain(".git");
  });

  it("summarizes the package manifest", () => {
    const map = buildRepoMap(root);
    expect(map).toContain("package.json (fixture)");
    expect(map).toContain("scripts: test, build");
  });
});

describe("project instructions", () => {
  it("returns null when none exist and loads them when present", () => {
    expect(loadInstructions(root)).toBeNull();
    writeFileSync(join(root, "AGENTS.md"), "# Rules\nUse tabs.\n");
    expect(loadInstructions(root)).toContain("Use tabs.");
  });
});
