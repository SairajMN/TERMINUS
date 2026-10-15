// Builds the publishable npm package: one bundled CLI file + manifest.
// Run: bun run dist
import { chmodSync, copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { VERSION } from "../apps/cli/src/version";

const root = join(import.meta.dir, "..");
const dist = join(root, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const result = await Bun.build({
  entrypoints: [join(root, "apps", "cli", "src", "main.ts")],
  target: "node",
  minify: true,
  sourcemap: "none",
  externals: ["bun:sqlite"],
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
const raw = await result.outputs[0].text();
const bundled = raw.startsWith("#!") ? raw.slice(raw.indexOf("\n") + 1) : raw;
const cliPath = join(dist, "terminus.js");
writeFileSync(cliPath, `#!/usr/bin/env node\n${bundled}`);
chmodSync(cliPath, 0o755);

writeFileSync(
  join(dist, "package.json"),
  `${JSON.stringify(
    {
      name: "terminus-agent",
      version: VERSION,
      description:
        "Autonomous coding agent: researches, plans, implements through a permission gate, verifies with your own tests, and reports evidence. Powered by NVIDIA Nemotron on Nebius Token Factory.",
      license: "MIT",
      author: "Sairaj M. Nadaf",
      repository: { type: "git", url: "git+https://github.com/SairajMN/TERMINUS.git" },
      keywords: ["ai", "agent", "coding-agent", "nemotron", "nebius", "cli"],
      type: "module",
      bin: { terminus: "terminus.js" },
      engines: { node: ">=22.5" },
      os: ["darwin", "linux"],
      files: ["terminus.js", "README.md", "LICENSE"],
    },
    null,
    2,
  )}\n`,
);
copyFileSync(join(root, "README.md"), join(dist, "README.md"));
copyFileSync(join(root, "LICENSE"), join(dist, "LICENSE"));
console.log(`dist built: terminus-agent@${VERSION}`);
