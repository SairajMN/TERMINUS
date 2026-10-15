import assert from "node:assert";
import { debounce } from "./src/events.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let count = 0;
const inc = debounce(() => {
  count++;
}, 15);
inc();
inc();
inc();
await sleep(70);
assert.strictEqual(count, 1, "calls inside one window collapse to a single invocation");

inc();
await sleep(70);
assert.strictEqual(count, 2, "a later call arms a fresh window");
console.log("ok");
