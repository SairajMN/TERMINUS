import { describe, expect, it } from "bun:test";
import { firstRun } from "./ui";

describe("first run screen", () => {
  it("fits the width and adapts to short terminals", () => {
    for (const row of firstRun(46, 24).split("\n")) expect(row.length).toBeLessThanOrEqual(46);
    const short = firstRun(80, 12);
    expect(short).not.toContain("plans approved");
    expect(firstRun(80, 24)).toContain("plans approved");
    expect(firstRun(46, 24)).not.toContain("research →");
    expect(firstRun(100, 24)).toContain("research →");
  });
});
