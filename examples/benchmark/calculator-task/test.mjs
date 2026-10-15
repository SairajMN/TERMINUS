import assert from "node:assert";
import { average, clamp, sum } from "./src/calculator.mjs";

assert.strictEqual(sum([1, 2, 3]), 6);
assert.strictEqual(average([1, 2, 3, 4]), 2.5);
assert.strictEqual(average([10]), 10);
assert.strictEqual(average([-2, 2]), 0);
assert.strictEqual(clamp(-5, 0, 10), 0);
assert.strictEqual(clamp(15, 0, 10), 10);
console.log("ok");
