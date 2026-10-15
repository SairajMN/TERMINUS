import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanShortcuts } from "./debt";

describe("shortcut ledger", () => {
  it("finds marked shortcuts and skips vendored trees", () => {
    const root = mkdtempSync(join(tmpdir(), "terminus-debt-"));
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "node_modules"));
    writeFileSync(
      join(root, "src", "a.ts"),
      "const a = 1; // shortcut: global cache until throughput matters\n",
    );
    writeFileSync(join(root, "src", "b.ts"), "export const b = 2;\n");
    writeFileSync(join(root, "node_modules", "c.js"), "// shortcut: hidden in deps\n");
    const found = scanShortcuts(root);
    expect(found).toHaveLength(1);
    expect(found[0]?.file).toBe("src/a.ts");
    expect(found[0]?.line).toBe(1);
    expect(found[0]?.text).toContain("global cache");
  });
});
