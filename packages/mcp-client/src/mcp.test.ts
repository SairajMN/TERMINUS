import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemorySecretVault, MCP_CONNECTION_PRESETS, McpConnectionManager } from "./index";

const tempDirs: string[] = [];
const managers: McpConnectionManager[] = [];

afterEach(async () => {
  for (const m of managers.splice(0)) {
    await m.shutdownAll();
  }
  for (const d of tempDirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

describe("MCP Connection Manager & Permission Enforcement", () => {
  it("ships validated connection presets and connects to a live stdio MCP server with tool discovery, untrusted wrapping, and mid-run failure recovery", async () => {
    expect(MCP_CONNECTION_PRESETS.length).toBeGreaterThanOrEqual(5);

    const dir = mkdtempSync(join(tmpdir(), "mcp-test-"));
    tempDirs.push(dir);

    const mockServerScript = join(dir, "mock-mcp-server.js");
    writeFileSync(
      mockServerScript,
      `import { createInterface } from "node:readline";
      const rl = createInterface({ input: process.stdin });
      rl.on("line", (line) => {
        const req = JSON.parse(line);
        if (req.method === "initialize") {
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0",
            id: req.id,
            result: { protocolVersion: "2024-11-05", serverInfo: { name: "mock-mcp", version: "2.1.0" } }
          }) + "\\n");
        } else if (req.method === "tools/list") {
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0",
            id: req.id,
            result: {
              tools: [
                { name: "get_issue", description: "Reads an issue", inputSchema: { type: "object" } },
                { name: "update_issue", description: "Mutates an issue", inputSchema: { type: "object" } },
                { name: "crash_server", description: "Simulates server crash", inputSchema: { type: "object" } }
              ]
            }
          }) + "\\n");
        } else if (req.method === "tools/call") {
          if (req.params.name === "crash_server") {
            process.exit(1);
          }
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0",
            id: req.id,
            result: {
              content: [{ type: "text", text: "Issue #42 retrieved with token=" + (process.env.MOCK_TOKEN || "none") }]
            }
          }) + "\\n");
        }
      });`,
    );

    const vault = new InMemorySecretVault();
    vault.setSecret("mcp:mock:token", "top-secret-value-12345");

    const manager = new McpConnectionManager({ secretVault: vault });
    managers.push(manager);

    manager.registerServer({
      id: "mock-tracker",
      name: "Mock Issue Tracker",
      transport: "stdio",
      command: process.execPath,
      args: [mockServerScript],
      secretEnvRefs: { MOCK_TOKEN: "mcp:mock:token" },
      enabled: true,
      timeoutMs: 3000,
      defaultPermissionTier: "modify",
    });

    const health = await manager.connectServer("mock-tracker");
    expect(health.status).toBe("connected");
    expect(health.serverVersion).toBe("2.1.0");
    expect(health.tools.length).toBe(3);

    // 1. In "plan" mode, read-inferred tool `get_issue` is allowed, `update_issue` is denied by PermissionEngine!
    const planTools = manager.getExecutableTools({ workspaceRoot: dir, mode: "plan" });
    const getIssueTool = planTools.find((t) => t.name === "mcp__mock-tracker__get_issue");
    const updateIssueTool = planTools.find((t) => t.name === "mcp__mock-tracker__update_issue");
    if (!getIssueTool || !updateIssueTool) throw new Error("Expected MCP tools");

    const readOut = await getIssueTool.execute({ id: 42 } as never, {
      workspaceRoot: dir,
      signal: new AbortController().signal,
    });
    expect(readOut.ok).toBe(true);
    expect(readOut.output).toContain("<untrusted_mcp_output");
    expect(readOut.output).toContain("Issue #42 retrieved");

    const writeBlocked = await updateIssueTool.execute({ id: 42 } as never, {
      workspaceRoot: dir,
      signal: new AbortController().signal,
    });
    expect(writeBlocked.ok).toBe(false);
    expect(writeBlocked.output).toContain("blocked by policy");

    // 2. Simulate MCP server crashing mid-execution -> fails gracefully without crashing TERMINUS, then auto-reconnects on next call!
    const actTools = manager.getExecutableTools({ workspaceRoot: dir, mode: "auto" });
    const crashTool = actTools.find((t) => t.name === "mcp__mock-tracker__crash_server");
    if (!crashTool) throw new Error("Expected crash_server tool");
    const crashOut = await crashTool.execute({} as never, {
      workspaceRoot: dir,
      signal: new AbortController().signal,
    });
    expect(crashOut.ok).toBe(false);
    expect(crashOut.output).toContain('MCP server "mock-tracker" failed');

    // Next call to `get_issue` automatically reconnects and succeeds!
    const recoveredOut = await getIssueTool.execute({ id: 99 } as never, {
      workspaceRoot: dir,
      signal: new AbortController().signal,
    });
    expect(recoveredOut.ok).toBe(true);
    expect(recoveredOut.output).toContain("Issue #42 retrieved");
  });
});
