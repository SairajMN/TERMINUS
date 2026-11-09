import readline from "node:readline";

export interface MenuItem<T> {
  label: string;
  value: T;
  hint?: string;
  badge?: string;
}

export async function interactiveSelect<T>(
  title: string,
  items: MenuItem<T>[],
  initialIndex = 0,
): Promise<T | null> {
  if (!process.stdin.isTTY || items.length === 0) {
    return items[0]?.value ?? null;
  }

  let selectedIndex = Math.min(Math.max(0, initialIndex), items.length - 1);

  // Setup raw mode
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }

  const render = () => {
    // Move cursor up if not first render
    process.stdout.write("\x1B[?25l"); // Hide cursor
    process.stdout.write(`\n  \x1B[1m${title}\x1B[0m\n`);
    process.stdout.write(
      `  \x1B[90m(Use ↑/↓ arrows to navigate, Enter to select, Esc/q to exit)\x1B[0m\n\n`,
    );

    items.forEach((item, idx) => {
      const isSelected = idx === selectedIndex;
      const cursor = isSelected ? "\x1B[1m❯\x1B[0m" : " ";
      const label = isSelected
        ? `\x1B[1m\x1B[4m${item.label}\x1B[0m`
        : `\x1B[37m${item.label}\x1B[0m`;
      const badge = item.badge ? ` \x1B[90m[${item.badge}]\x1B[0m` : "";
      const hint = item.hint ? ` \x1B[90m— ${item.hint}\x1B[0m` : "";
      process.stdout.write(`   ${cursor} ${label}${badge}${hint}\n`);
    });
  };

  const clearLines = () => {
    const lineCount = items.length + 4;
    for (let i = 0; i < lineCount; i++) {
      process.stdout.write("\x1B[1A\x1B[2K");
    }
  };

  render();

  return new Promise<T | null>((resolve) => {
    const onKeypress = (_str: string, key: readline.Key) => {
      if (key.name === "up" || key.name === "k") {
        selectedIndex = (selectedIndex - 1 + items.length) % items.length;
        clearLines();
        render();
      } else if (key.name === "down" || key.name === "j") {
        selectedIndex = (selectedIndex + 1) % items.length;
        clearLines();
        render();
      } else if (key.name === "return") {
        cleanup();
        clearLines();
        resolve(items[selectedIndex]?.value ?? null);
      } else if (key.name === "escape" || key.name === "q" || (key.ctrl && key.name === "c")) {
        cleanup();
        clearLines();
        resolve(null);
      }
    };

    const cleanup = () => {
      process.stdin.removeListener("keypress", onKeypress);
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      process.stdout.write("\x1B[?25h"); // Show cursor
    };

    process.stdin.on("keypress", onKeypress);
  });
}
