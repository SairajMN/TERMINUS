import { z } from "zod";

export const McpToolOverrideSchema = z.object({
  enabled: z.boolean().default(true),
  tier: z.enum(["read", "modify", "high_impact"]).default("modify"),
});

export type McpToolOverride = z.infer<typeof McpToolOverrideSchema>;

export const McpServerConfigSchema = z.discriminatedUnion("transport", [
  z.object({
    id: z.string().regex(/^[a-z0-9-]+$/, "MCP server id must be kebab-case"),
    name: z.string().min(1).max(80),
    transport: z.literal("stdio"),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    cwd: z.string().optional(),
    env: z.record(z.string(), z.string()).default({}),
    secretEnvRefs: z.record(z.string(), z.string()).default({}),
    enabled: z.boolean().default(true),
    timeoutMs: z.number().int().min(100).max(120_000).default(15_000),
    defaultPermissionTier: z.enum(["read", "modify", "high_impact"]).default("modify"),
    toolOverrides: z.record(z.string(), McpToolOverrideSchema).default({}),
  }),
  z.object({
    id: z.string().regex(/^[a-z0-9-]+$/, "MCP server id must be kebab-case"),
    name: z.string().min(1).max(80),
    transport: z.enum(["sse", "streamable-http"]),
    url: z.string().url(),
    headers: z.record(z.string(), z.string()).default({}),
    secretHeaderRefs: z.record(z.string(), z.string()).default({}),
    enabled: z.boolean().default(true),
    timeoutMs: z.number().int().min(100).max(120_000).default(15_000),
    defaultPermissionTier: z.enum(["read", "modify", "high_impact"]).default("modify"),
    toolOverrides: z.record(z.string(), McpToolOverrideSchema).default({}),
  }),
]);

export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

export interface SecretVault {
  getSecret(key: string): Promise<string | undefined> | string | undefined;
  setSecret(key: string, value: string): Promise<void> | void;
  deleteSecret(key: string): Promise<void> | void;
  listSecretKeys(): Promise<string[]> | string[];
}

export class InMemorySecretVault implements SecretVault {
  private readonly secrets = new Map<string, string>();

  getSecret(key: string): string | undefined {
    return this.secrets.get(key);
  }

  setSecret(key: string, value: string): void {
    this.secrets.set(key, value);
  }

  deleteSecret(key: string): void {
    this.secrets.delete(key);
  }

  listSecretKeys(): string[] {
    return [...this.secrets.keys()].sort();
  }
}

export interface McpPresetDefinition {
  id: string;
  name: string;
  category:
    | "code_hosting"
    | "project_management"
    | "database"
    | "browser"
    | "search"
    | "communication"
    | "cloud";
  description: string;
  requiredSecrets: string[];
  template: McpServerConfig;
}

const RAW_PRESETS: McpPresetDefinition[] = [
  {
    id: "github",
    name: "GitHub MCP",
    category: "code_hosting",
    description: "Pull requests, issues, repository search, and workflow runs via GitHub API.",
    requiredSecrets: ["GITHUB_PERSONAL_ACCESS_TOKEN"],
    template: {
      id: "github",
      name: "GitHub MCP",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: {},
      secretEnvRefs: { GITHUB_PERSONAL_ACCESS_TOKEN: "mcp:github:pat" },
      enabled: true,
      timeoutMs: 15_000,
      defaultPermissionTier: "modify",
      toolOverrides: {},
    },
  },
  {
    id: "gitlab",
    name: "GitLab MCP",
    category: "code_hosting",
    description: "Merge requests, pipelines, and project issue tracking for GitLab.",
    requiredSecrets: ["GITLAB_PERSONAL_ACCESS_TOKEN"],
    template: {
      id: "gitlab",
      name: "GitLab MCP",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-gitlab"],
      env: {},
      secretEnvRefs: { GITLAB_PERSONAL_ACCESS_TOKEN: "mcp:gitlab:token" },
      enabled: true,
      timeoutMs: 15_000,
      defaultPermissionTier: "modify",
      toolOverrides: {},
    },
  },
  {
    id: "linear",
    name: "Linear Issues",
    category: "project_management",
    description: "Query, create, and update Linear engineering issues and sprint cycles.",
    requiredSecrets: ["LINEAR_API_KEY"],
    template: {
      id: "linear",
      name: "Linear Issues",
      transport: "stdio",
      command: "npx",
      args: ["-y", "mcp-remote", "https://mcp.linear.app/sse"],
      env: {},
      secretEnvRefs: { LINEAR_API_KEY: "mcp:linear:api_key" },
      enabled: true,
      timeoutMs: 15_000,
      defaultPermissionTier: "modify",
      toolOverrides: {},
    },
  },
  {
    id: "postgres",
    name: "PostgreSQL Inspector",
    category: "database",
    description: "Read-only schema inspection and parameterized SQL query diagnostics.",
    requiredSecrets: ["POSTGRES_CONNECTION_URL"],
    template: {
      id: "postgres",
      name: "PostgreSQL Inspector",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-postgres"],
      env: {},
      secretEnvRefs: { POSTGRES_CONNECTION_URL: "mcp:postgres:url" },
      enabled: true,
      timeoutMs: 15_000,
      defaultPermissionTier: "read",
      toolOverrides: {},
    },
  },
  {
    id: "browser-research",
    name: "Playwright Browser Automation",
    category: "browser",
    description: "Headless DOM inspection, accessibility snapshots, and live UI verification.",
    requiredSecrets: [],
    template: {
      id: "browser-research",
      name: "Playwright Browser Automation",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@playwright/mcp@latest"],
      env: {},
      secretEnvRefs: {},
      enabled: true,
      timeoutMs: 25_000,
      defaultPermissionTier: "modify",
      toolOverrides: {},
    },
  },
  {
    id: "slack",
    name: "Slack Workspace Connector",
    category: "communication",
    description: "Read engineering channel threads and post verified release summaries.",
    requiredSecrets: ["SLACK_BOT_TOKEN"],
    template: {
      id: "slack",
      name: "Slack Workspace Connector",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-slack"],
      env: {},
      secretEnvRefs: { SLACK_BOT_TOKEN: "mcp:slack:bot_token" },
      enabled: true,
      timeoutMs: 15_000,
      defaultPermissionTier: "high_impact",
      toolOverrides: {},
    },
  },
];

export const MCP_CONNECTION_PRESETS: readonly McpPresetDefinition[] = Object.freeze(RAW_PRESETS);
