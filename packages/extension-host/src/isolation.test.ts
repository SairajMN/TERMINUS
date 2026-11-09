import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateExtensionManifest } from "@terminus/extension-sdk";
import { ExtensionHost } from "./host";

const tempDirs: string[] = [];
const activeHosts: ExtensionHost[] = [];

const makeTempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};

afterEach(async () => {
  for (const h of activeHosts.splice(0)) {
    await h.shutdownAll();
  }
  for (const d of tempDirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

describe("Extension SDK & Isolated ExtensionHost (Rules 1-12)", () => {
  it("validates extension manifests strictly and blocks path traversal entrypoints", () => {
    const ok = validateExtensionManifest({
      id: "browser-research",
      name: "Browser Research",
      version: "1.0.0",
      description: "Adds browser research capabilities",
      capabilities: ["tools"],
      permissions: ["network"],
      entrypoint: "dist/index.js",
    });
    expect(ok.valid).toBe(true);

    const traversal = validateExtensionManifest({
      id: "evil-plugin",
      name: "Evil Plugin",
      version: "1.0.0",
      description: "Tries traversal",
      capabilities: ["tools"],
      entrypoint: "../outside.js",
    });
    expect(traversal.valid).toBe(false);
  });

  it("scaffolds, activates, and executes a healthy extension in an isolated subprocess without leaking host API keys", async () => {
    process.env.NEBIUS_API_KEY = "secret-host-key-do-not-leak";
    const root = makeTempDir("ext-healthy-");
    const host = new ExtensionHost();
    activeHosts.push(host);

    const extDir = join(root, "env-check");
    mkdirSync(join(extDir, "src"), { recursive: true });
    writeFileSync(
      join(extDir, "terminus-extension.json"),
      JSON.stringify({
        id: "env-check",
        name: "Env Check Plugin",
        version: "1.0.0",
        description: "Checks isolated worker env",
        entrypoint: "src/index.ts",
        capabilities: ["tools"],
        permissions: ["fs:read"],
        timeoutMs: 3000,
      }),
    );
    writeFileSync(
      join(extDir, "src", "index.ts"),
      `export default {
        setup(ctx) {
          ctx.logger.info("Booting isolated plugin");
          ctx.registerTool({
            name: "probe_env",
            description: "Checks whether host API keys leaked into worker",
            tier: "read",
            execute: async () => ({
              ok: true,
              output: process.env.NEBIUS_API_KEY ? "LEAKED" : "ISOLATED_CLEAN",
            }),
          });
        }
      };`,
    );

    const reg = host.registerExtensionDirectory(extDir);
    expect(reg.valid).toBe(true);

    const state = await host.activateExtension("env-check", root);
    expect(state.status).toBe("healthy");
    expect(state.registeredTools.length).toBe(1);

    const res = await host.invokeExtensionTool("env-check", "probe_env", {}, root);
    expect(res.ok).toBe(true);
    expect(res.output).toBe("ISOLATED_CLEAN");

    const logs = host.getExtensionLogs("env-check");
    expect(logs.some((l) => l.message.includes("Booting isolated plugin"))).toBe(true);
  });

  it("isolates plugin crashes (process.exit(1)), trips the circuit breaker after 3 crashes, and never crashes the host", async () => {
    const root = makeTempDir("ext-crash-");
    const host = new ExtensionHost({ maxFailuresBeforeCircuitOpen: 3 });
    activeHosts.push(host);

    const extDir = join(root, "crasher");
    mkdirSync(extDir, { recursive: true });
    writeFileSync(
      join(extDir, "terminus-extension.json"),
      JSON.stringify({
        id: "crasher",
        name: "Crasher Plugin",
        version: "1.0.0",
        description: "Crashes intentionally on tool execution",
        entrypoint: "index.ts",
        capabilities: ["tools"],
        timeoutMs: 2000,
      }),
    );
    writeFileSync(
      join(extDir, "index.ts"),
      `export default (ctx) => {
        ctx.registerTool({
          name: "boom",
          description: "Exits worker process immediately",
          tier: "read",
          execute: () => {
            process.exit(1);
          },
        });
      };`,
    );

    host.registerExtensionDirectory(extDir);
    await host.activateExtension("crasher", root);

    const r1 = await host.invokeExtensionTool("crasher", "boom", {}, root);
    expect(r1.ok).toBe(false);

    const r2 = await host.invokeExtensionTool("crasher", "boom", {}, root);
    expect(r2.ok).toBe(false);

    const r3 = await host.invokeExtensionTool("crasher", "boom", {}, root);
    expect(r3.ok).toBe(false);

    const state = host.getExtensionState("crasher");
    expect(state?.status).toBe("circuit_open");

    // Subsequent call fast-fails via circuit breaker without spawning a new process
    const r4 = await host.invokeExtensionTool("crasher", "boom", {}, root);
    expect(r4.ok).toBe(false);
    expect(r4.output).toContain("circuit breaker open");
  });

  it("rejects malformed plugin tool outputs via Zod schema validation", async () => {
    const root = makeTempDir("ext-malformed-");
    const host = new ExtensionHost();
    activeHosts.push(host);

    const extDir = join(root, "bad-output");
    mkdirSync(extDir, { recursive: true });
    writeFileSync(
      join(extDir, "terminus-extension.json"),
      JSON.stringify({
        id: "bad-output",
        name: "Malformed Output Plugin",
        version: "1.0.0",
        description: "Returns invalid schema",
        entrypoint: "index.ts",
        capabilities: ["tools"],
        timeoutMs: 2000,
      }),
    );
    writeFileSync(
      join(extDir, "index.ts"),
      `export default (ctx) => {
        ctx.registerTool({
          name: "corrupt",
          description: "Returns wrong object shape",
          tier: "read",
          execute: () => ({ unexpectedField: 42 }),
        });
      };`,
    );

    host.registerExtensionDirectory(extDir);
    await host.activateExtension("bad-output", root);

    const res = await host.invokeExtensionTool("bad-output", "corrupt", {}, root);
    expect(res.ok).toBe(false);
    expect(res.output).toContain("malformed output");
  });

  it("terminates a hung infinite-loop plugin when it exceeds timeoutMs and keeps the host responsive", async () => {
    const root = makeTempDir("ext-timeout-");
    const host = new ExtensionHost();
    activeHosts.push(host);

    const extDir = join(root, "hang-plugin");
    mkdirSync(extDir, { recursive: true });
    writeFileSync(
      join(extDir, "terminus-extension.json"),
      JSON.stringify({
        id: "hang-plugin",
        name: "Hang Plugin",
        version: "1.0.0",
        description: "Blocks forever",
        entrypoint: "index.ts",
        capabilities: ["tools"],
        timeoutMs: 180,
      }),
    );
    writeFileSync(
      join(extDir, "index.ts"),
      `export default (ctx) => {
        ctx.registerTool({
          name: "freeze",
          description: "Infinite CPU loop",
          tier: "read",
          execute: () => {
            while (true) {}
          },
        });
      };`,
    );

    host.registerExtensionDirectory(extDir);
    await host.activateExtension("hang-plugin", root);

    const startedAt = Date.now();
    const res = await host.invokeExtensionTool("hang-plugin", "freeze", {}, root);
    const elapsed = Date.now() - startedAt;

    expect(res.ok).toBe(false);
    expect(res.output).toContain("exceeded timeout");
    expect(elapsed).toBeLessThan(3000);
  });

  it("enforces PermissionEngine modes on extension tools and supports disabling active extensions", async () => {
    const root = makeTempDir("ext-perm-");
    const host = new ExtensionHost();
    activeHosts.push(host);

    const scaffolded = host.scaffoldExtensionTemplate(root, {
      id: "custom-helper",
      name: "Custom Helper",
      description: "Scaffolded extension test",
    });

    // Add a modify-tier tool to verify plan-mode blocking
    writeFileSync(
      join(scaffolded.directory, "src", "index.ts"),
      `export default (ctx) => {
        ctx.registerTool({
          name: "mutate_thing",
          description: "Modify tier tool",
          tier: "modify",
          execute: () => ({ ok: true, output: "mutated" }),
        });
      };`,
    );

    host.registerExtensionDirectory(scaffolded.directory);
    await host.activateExtension("custom-helper", root);

    const planTools = host.getExecutableTools({ workspaceRoot: root, mode: "plan" });
    expect(planTools.length).toBe(1);
    const firstPlanTool = planTools[0];
    if (!firstPlanTool) throw new Error("Expected extension tool");

    const blockedInPlan = await firstPlanTool.execute({} as never, {
      workspaceRoot: root,
      signal: new AbortController().signal,
    });
    expect(blockedInPlan.ok).toBe(false);
    expect(blockedInPlan.output).toContain("blocked by policy");

    await host.disableExtension("custom-helper");
    expect(host.getExtensionState("custom-helper")?.status).toBe("disabled");
    expect(host.getExecutableTools({ workspaceRoot: root, mode: "act" }).length).toBe(0);
  });
});
