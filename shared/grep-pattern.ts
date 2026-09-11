/**
 * Grep pattern safety screen shared by the agent engine and user-facing search.
 *
 * One validator: agent-core's grep tool and Electron's content search both
 * run caller-supplied regular expressions, and both must reject nested
 * quantifiers, groups, and backreferences before compiling them. Returns an
 * error message, or null when the pattern is safe to compile.
 */
export function validateGrepPattern(pattern: string): string | null {
  if (pattern.length < 1 || pattern.length > 256) return "error: pattern length must be 1–256";
  let i = 0;
  let inClass = false;
  let quantifiers = 0;
  while (i < pattern.length) {
    const c = pattern[i]!;
    if (c === "\\" && i + 1 < pattern.length) {
      const n = pattern[i + 1]!;
      if (n >= "0" && n <= "9") return "error: unsafe regular expression";
      i += 2;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      i++;
      continue;
    }
    if (c === "[") {
      inClass = true;
      i++;
      continue;
    }
    if (c === "(" || c === ")") return "error: unsafe regular expression";
    if (c === "*" || c === "+" || c === "?") {
      quantifiers++;
      if (quantifiers > 1) return "error: unsafe regular expression";
      i++;
      continue;
    }
    if (c === "{") {
      const close = pattern.indexOf("}", i);
      if (close < 0) return "error: invalid regular expression";
      quantifiers++;
      if (quantifiers > 1) return "error: unsafe regular expression";
      i = close + 1;
      continue;
    }
    i++;
  }
  if (inClass) return "error: invalid regular expression";
  return null;
}
