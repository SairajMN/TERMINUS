import { z } from "zod";

export const EXTENSION_CAPABILITIES = [
  "tools",
  "agents",
  "skills",
  "mcp_connectors",
  "browser",
  "research",
  "utilities",
  "ui_panels",
  "workflows",
  "lifecycle_hooks",
  "slash_commands",
  "output_renderers",
] as const;

export const ExtensionCapabilitySchema = z.enum(EXTENSION_CAPABILITIES);
export type ExtensionCapability = z.infer<typeof ExtensionCapabilitySchema>;

export const EXTENSION_PERMISSIONS = [
  "fs:read",
  "fs:write",
  "process:spawn",
  "network",
  "secrets:read",
  "session:read",
  "ui:panel",
] as const;

export const ExtensionPermissionSchema = z.enum(EXTENSION_PERMISSIONS);
export type ExtensionPermission = z.infer<typeof ExtensionPermissionSchema>;

export const ExtensionManifestSchema = z.object({
  id: z
    .string()
    .min(2)
    .max(64)
    .regex(/^[a-z0-9-]+$/, "Extension id must be kebab-case"),
  name: z.string().min(2).max(80),
  version: z.string().regex(/^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/, "Must be valid semver"),
  description: z.string().min(4).max(500),
  author: z.string().max(120).optional(),
  engineVersion: z.string().default(">=0.3.0"),
  entrypoint: z
    .string()
    .regex(/^[a-zA-Z0-9_./-]+\.(js|ts|mjs)$/, "Entrypoint must be a relative JS/TS module"),
  capabilities: z.array(ExtensionCapabilitySchema).min(1),
  permissions: z.array(ExtensionPermissionSchema).default([]),
  allowedHosts: z.array(z.string()).default([]),
  timeoutMs: z.number().int().min(100).max(120_000).default(10_000),
  memoryLimitMb: z.number().int().min(32).max(512).default(128),
  contributes: z
    .object({
      skills: z.array(z.string()).optional(),
      slashCommands: z
        .array(
          z.object({
            command: z.string().regex(/^\/[a-z0-9-]+$/),
            description: z.string().max(200),
          }),
        )
        .optional(),
    })
    .optional(),
});

export type ExtensionManifest = z.infer<typeof ExtensionManifestSchema>;

export function validateExtensionManifest(raw: unknown): {
  valid: boolean;
  manifest?: ExtensionManifest;
  errors: string[];
} {
  const parsed = ExtensionManifestSchema.safeParse(raw);
  if (parsed.success) {
    if (parsed.data.entrypoint.includes("..")) {
      return {
        valid: false,
        errors: ["entrypoint: Path traversal ('..') is forbidden in extension entrypoint"],
      };
    }
    return { valid: true, manifest: parsed.data, errors: [] };
  }
  return {
    valid: false,
    errors: parsed.error.issues.map((i) => `${i.path.join(".") || "manifest"}: ${i.message}`),
  };
}
