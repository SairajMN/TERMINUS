export interface StatusStream {
  write(text: string): unknown;
  isTTY?: boolean;
}

const unref = (timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>): void => {
  const handle = timer as { unref?: () => void };
  handle.unref?.();
};

export const createStatus = (stream: StatusStream, render: () => string) => {
  let idle: ReturnType<typeof setTimeout> | null = null;
  let live: ReturnType<typeof setInterval> | null = null;
  const enabled = Boolean(stream.isTTY);

  const stop = (): void => {
    if (idle) {
      clearTimeout(idle);
      idle = null;
    }
    if (live) {
      clearInterval(live);
      live = null;
      stream.write("\r\x1b[2K");
    }
  };

  const note = (): void => stop();

  const arm = (): void => {
    if (!enabled) return;
    stop();
    idle = setTimeout(() => {
      idle = null;
      stream.write(render());
      live = setInterval(() => {
        stream.write("\r\x1b[2K");
        stream.write(render());
      }, 110);
      unref(live);
    }, 130);
    unref(idle);
  };

  return { note, arm, stop };
};
