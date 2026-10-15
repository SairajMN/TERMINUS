import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config";

const userFile = join(homedir(), ".terminus", "config.json");
const created: string[] = [];
let originalUserConfig: string | null = null;

const makeProject = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "terminus-cfg-"));
  created.push(dir);
  return dir;
};

beforeEach(() => {
  originalUserConfig = existsSync(userFile) ? readFileSync(userFile, "utf8") : null;
});

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (originalUserConfig !== null) {
    writeFileSync(userFile, originalUserConfig);
  } else if (existsSync(userFile)) {
    rmSync(userFile);
  }
});

describe("config loading", () => {
  it("merges user and project config with project winning", () => {
    mkdirSync(join(homedir(), ".terminus"), { recursive: true });
    writeFileSync(userFile, JSON.stringify({ mode: "plan", model: "user-model" }));

    const project = makeProject();
    mkdirSync(join(project, ".terminus"));
    writeFileSync(
      join(project, ".terminus", "config.json"),
      JSON.stringify({ model: "project-model", verify: ["npm test"] }),
    );

    const config = loadConfig(project);
    expect(config.mode).toBe("plan");
    expect(config.model).toBe("project-model");
    expect(config.verify).toEqual(["npm test"]);
  });

  it("returns empty config when nothing exists", () => {
    expect(loadConfig(makeProject())).toEqual({});
  });
});
