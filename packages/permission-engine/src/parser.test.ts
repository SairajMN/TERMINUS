import { describe, expect, it } from "bun:test";
import { hasCommandSubstitution, hasOutputRedirection, splitCommandSegments } from "./parser";

describe("command parser: segment splitting", () => {
  it("splits simple commands with no operators as a single segment", () => {
    expect(splitCommandSegments("git status")).toEqual(["git status"]);
    expect(splitCommandSegments("ls -la src/")).toEqual(["ls -la src/"]);
  });

  it("splits commands chained with &&, ||, ;, and |", () => {
    expect(splitCommandSegments("cat file && rm -rf /")).toEqual(["cat file", "rm -rf /"]);
    expect(splitCommandSegments("npm test || echo failed ; git status")).toEqual([
      "npm test",
      "echo failed",
      "git status",
    ]);
    expect(splitCommandSegments("cat foo | grep bar | wc -l")).toEqual([
      "cat foo",
      "grep bar",
      "wc -l",
    ]);
  });

  it("preserves operators inside quotes without splitting", () => {
    expect(splitCommandSegments('git commit -m "feat: add a && b"')).toEqual([
      'git commit -m "feat: add a && b"',
    ]);
    expect(splitCommandSegments("grep 'foo; bar' test.txt")).toEqual(["grep 'foo; bar' test.txt"]);
    expect(splitCommandSegments('echo "hello | world" && git status')).toEqual([
      'echo "hello | world"',
      "git status",
    ]);
  });

  it("handles newlines as separators", () => {
    expect(splitCommandSegments("git status\nrm -rf /")).toEqual(["git status", "rm -rf /"]);
  });
});

describe("command parser: output redirection detection", () => {
  it("identifies > and >> as output redirection", () => {
    expect(hasOutputRedirection("cat file > /etc/passwd")).toBe(true);
    expect(hasOutputRedirection("echo test >> file.log")).toBe(true);
    expect(hasOutputRedirection("cat file 2> /dev/null")).toBe(true);
  });

  it("ignores > when contained within single or double quotes", () => {
    expect(hasOutputRedirection('git commit -m "fix: a > b"')).toBe(false);
    expect(hasOutputRedirection("grep '> 10' src/math.ts")).toBe(false);
    expect(hasOutputRedirection("node -e 'if (x > y) {}'")).toBe(false);
  });
});

describe("command parser: command substitution detection", () => {
  it("detects backticks and $(...) outside quotes", () => {
    expect(hasCommandSubstitution("cat `id_rsa`")).toBe(true);
    expect(hasCommandSubstitution("echo $(whoami)")).toBe(true);
    expect(hasCommandSubstitution('echo "$(whoami)"')).toBe(true);
  });

  it("ignores backticks and $ inside single quotes", () => {
    expect(hasCommandSubstitution("echo '`id_rsa`'")).toBe(false);
    expect(hasCommandSubstitution("echo '$(whoami)'")).toBe(false);
  });
});
