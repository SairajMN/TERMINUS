import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config";

describe("config loading", () => {
  it("merges user and project config with project winning", () => {
    const userDir = join(homedir(), ".terminus");
    const userFile = join(userDir, "config.json");
    const hadUser = expectNoThrowRead(userFile);
    mkdirSync(userDir, { recursive: true });
    writeFileSync(userFile, JSON.stringify({ mode: "plan", model: "user-model" }));

    const project = mkdtempSync(join(import.meta.dir, "cfg-"));
    mkdirSync(join(project, ".terminus"));
    writeFileSync(
      join(project, ".terminus", "config.json"),
      JSON.stringify({ model: "project-model", verify: ["npm test"] }),
    );

    const config = loadConfig(project);
    expect(config.mode).toBe("plan");
    expect(config.model).toBe("project-model");
    expect(config.verify).toEqual(["npm test"]);

    if (hadUser) writeFileSync(userFile, hadUser);
    else {
      try {
        writeFileSync(userFile, "");
        require("node:fs").rmSync(userFile);
      } catch {}
    }
  });

  it("returns empty config when nothing exists", () => {
    const project = mkdtempSync(join(import.meta.dir, "cfg-empty-"));
    expect(loadConfig(project)).toEqual({});
  });
});

function expectNoThrowRead(path: string): string | null {
  try {
    return require("node:fs").readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
