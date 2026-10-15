import assert from "node:assert";
import { truncate } from "./src/strings.mjs";

assert.strictEqual(truncate("hello", 10), "hello");
assert.strictEqual(truncate("hello world", 5), "hello...");
assert.strictEqual(truncate("", 3), "");
assert.strictEqual(truncate("abcdef", 3), "abc...");
console.log("ok");
