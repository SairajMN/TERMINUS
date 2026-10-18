import { describe, expect, it } from "bun:test";
import { clip, fitHeight, fitWidth, shortPath, wrap } from "./fit";

describe("fit", () => {
  it("clamps terminal dimensions", () => {
    expect(fitWidth(30)).toBe(40);
    expect(fitWidth(500)).toBe(200);
    expect(fitWidth(120)).toBe(120);
    expect(fitHeight(5)).toBe(10);
    expect(fitHeight(400)).toBe(120);
    expect(fitWidth(undefined)).toBeGreaterThanOrEqual(40);
  });

  it("clips with an ellipsis", () => {
    expect(clip("abcdef", 6)).toBe("abcdef");
    expect(clip("abcdef", 4)).toBe("abc…");
    expect(clip("abcdef", 1)).toBe("…");
    expect(clip("abc", 0)).toBe("");
  });

  it("wraps words within the width", () => {
    expect(wrap("one two three", 7)).toEqual(["one two", "three"]);
    expect(wrap("supercalifragilistic", 6)).toEqual(["superca…"]);
    expect(wrap("", 10)).toEqual([""]);
  });

  it("shortens paths to the width", () => {
    expect(shortPath("/repo/src", 20)).toBe("/repo/src");
    expect(shortPath("/Users/dev/project/src/deep.ts", 25, "/Users/dev")).toBe(
      "~/project/src/deep.ts",
    );
    expect(shortPath("/Users/dev/project/src/deep.ts", 12, "/Users/dev")).toBe("…/deep.ts");
    expect(shortPath("/Users/dev/project/src/deep.ts", 1, "/Users/dev")).toBe("…");
  });
});
