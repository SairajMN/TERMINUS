import { describe, expect, it } from "bun:test";
import { canTransition, sha256, TaskMachine } from "./index";

describe("task state machine", () => {
  it("walks the happy path", () => {
    const m = new TaskMachine();
    for (const s of [
      "investigating",
      "planning",
      "awaiting_approval",
      "implementing",
      "verifying",
      "completed",
    ] as const) {
      m.to(s);
    }
    expect(m.finished).toBe(true);
  });

  it("routes failed verification through diagnosis back to implementation", () => {
    const m = new TaskMachine();
    m.to("investigating");
    m.to("planning");
    m.to("awaiting_approval");
    m.to("implementing");
    m.to("failed_check");
    m.to("diagnosing");
    m.to("implementing");
    m.to("verifying");
    m.to("completed");
    expect(m.state).toBe("completed");
  });

  it("rejects skipping phases", () => {
    expect(canTransition("queued", "implementing")).toBe(false);
    expect(canTransition("planning", "completed")).toBe(false);
    expect(canTransition("completed", "implementing")).toBe(false);
    const m = new TaskMachine();
    expect(() => m.to("completed")).toThrow("invalid task transition");
  });
});

describe("sha256", () => {
  it("is deterministic and content-sensitive", () => {
    expect(sha256("abc")).toBe(sha256("abc"));
    expect(sha256("abc")).not.toBe(sha256("abd"));
    expect(sha256("abc")).toHaveLength(64);
  });
});
