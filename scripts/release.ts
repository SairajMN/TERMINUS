// Release: verify everything, build dist, then publish to npm.
// Run: bun run release   (requires npm login)
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const run = (cmd: string[], cwd?: string): void => {
  const result = spawnSync(cmd[0] as string, cmd.slice(1), { stdio: "inherit", cwd });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

run(["bun", "test", "--timeout", "60000"], join(import.meta.dir, ".."));
run(["bun", "run", "typecheck"], join(import.meta.dir, ".."));
run(["bun", "run", "dist"], join(import.meta.dir, ".."));
run(["npm", "publish"], join(import.meta.dir, "..", "dist"));
console.log("published terminus-agent — install with: npm i -g terminus-agent");
