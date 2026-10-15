import assert from "node:assert";
import { formatForTimezone } from "./src/date.mjs";

assert.strictEqual(
  formatForTimezone("2026-10-30T12:00:00Z", "Asia/Kolkata"),
  "2026-10-30 17:30",
  "Asia/Kolkata is UTC+5:30",
);
assert.strictEqual(
  formatForTimezone("2026-01-15T08:45:00Z", "America/New_York"),
  "2026-01-15 03:45",
  "New York is UTC-5 in January",
);
console.log("ok");
