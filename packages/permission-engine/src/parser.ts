/**
 * Splits a complex shell command line into discrete executable segment strings,
 * respecting single/double quotes and backslash escapes.
 *
 * Examples:
 *   "ls -la && cat foo | grep bar ; rm -rf /"
 *   -> ["ls -la", "cat foo", "grep bar", "rm -rf /"]
 */
export function splitCommandSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let isEscaped = false;

  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (char === undefined) continue;

    if (isEscaped) {
      current += char;
      isEscaped = false;
      continue;
    }

    if (char === "\\") {
      isEscaped = true;
      current += char;
      continue;
    }

    if (char === "'" && !inDouble) {
      inSingle = !inSingle;
      current += char;
      continue;
    }

    if (char === '"' && !inSingle) {
      inDouble = !inDouble;
      current += char;
      continue;
    }

    if (!inSingle && !inDouble) {
      // Check for operators: &&, ||, ;, |, \n, &
      if (char === "\n" || char === ";") {
        if (current.trim().length > 0) segments.push(current.trim());
        current = "";
        continue;
      }
      if (char === "&" && command[i + 1] === "&") {
        if (current.trim().length > 0) segments.push(current.trim());
        current = "";
        i++; // skip second &
        continue;
      }
      if (char === "|" && command[i + 1] === "|") {
        if (current.trim().length > 0) segments.push(current.trim());
        current = "";
        i++; // skip second |
        continue;
      }
      if (char === "|" && command[i + 1] !== "|") {
        if (current.trim().length > 0) segments.push(current.trim());
        current = "";
        continue;
      }
      if (char === "&" && command[i + 1] !== "&") {
        if (current.trim().length > 0) segments.push(current.trim());
        current = "";
        continue;
      }
    }

    current += char;
  }

  if (current.trim().length > 0) {
    segments.push(current.trim());
  }

  return segments;
}

/**
 * Detects whether a shell command segment contains output redirection operators (> or >>)
 * outside of quotes, which mutate files and should never be classified as read-only.
 */
export function hasOutputRedirection(segment: string): boolean {
  let inSingle = false;
  let inDouble = false;
  let isEscaped = false;

  for (let i = 0; i < segment.length; i++) {
    const char = segment[i];
    if (char === undefined) continue;
    if (isEscaped) {
      isEscaped = false;
      continue;
    }
    if (char === "\\") {
      isEscaped = true;
      continue;
    }
    if (char === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (char === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (!inSingle && !inDouble && char === ">") {
      return true;
    }
  }
  return false;
}

/**
 * Detects command substitution: `...` or $(...) outside quotes.
 */
export function hasCommandSubstitution(segment: string): boolean {
  let inSingle = false;
  let isEscaped = false;

  for (let i = 0; i < segment.length; i++) {
    const char = segment[i];
    if (char === undefined) continue;
    if (isEscaped) {
      isEscaped = false;
      continue;
    }
    if (char === "\\") {
      isEscaped = true;
      continue;
    }
    if (char === "'") {
      inSingle = !inSingle;
      continue;
    }
    if (!inSingle) {
      if (char === "`") return true;
      if (char === "$" && segment[i + 1] === "(") return true;
    }
  }
  return false;
}
