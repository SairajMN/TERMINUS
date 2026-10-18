import { describe, expect, it } from "bun:test";
import { createStatus } from "./status";

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("status line", () => {
  it("draws after arming and clears when an event arrives", async () => {
    const written: string[] = [];
    const status = createStatus(
      {
        write: (text: string) => {
          written.push(text);
          return text.length;
        },
        isTTY: true,
      },
      () => "… working",
    );
    status.arm();
    await wait(180);
    expect(written.join("")).toContain("working");
    const before = written.length;
    status.note();
    expect(written.length).toBe(before + 1);
    expect(written.at(-1)).toContain("\r\x1b[2K");
    status.stop();
  });

  it("stays silent without a tty", async () => {
    const written: string[] = [];
    const status = createStatus(
      {
        write: (text: string) => {
          written.push(text);
          return 0;
        },
      },
      () => "x",
    );
    status.arm();
    await wait(180);
    expect(written).toHaveLength(0);
    status.stop();
  });
});
