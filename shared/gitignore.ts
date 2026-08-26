/**
 * Shared ignore rules for the project watcher and agent-core walks.
 *
 * One pattern compiler. Walkers load .gitignore files; this module only
 * parses and matches. Escaped literals such as a leading "\!" stay
 * unsupported.
 */
export const IGNORED_SEGMENTS = new Set([
  "node_modules",
  ".git",
  ".pi",
  ".agents",
  ".next",
  ".nuxt",
  ".cache",
  ".parcel-cache",
  ".turbo",
  ".yarn",
  ".venv",
  "venv",
  "dist",
  "out",
  "build",
  "coverage",
  ".DS_Store",
  "vendor",
  ".idea",
  ".vscode",
  ".hg",
  ".svn",
  ".terraform",
  ".serverless",
  ".expo",
  ".android",
  ".ios",
]);

/** One compiled pattern line of a .gitignore file. */
export interface GitignoreRule {
  /** True for a "!" pattern. A match re-includes the path. */
  negated: boolean;
  /** True for a pattern with a trailing "/". Only directories match. */
  dirOnly: boolean;
  /** Matches the path relative to the .gitignore directory. */
  re: RegExp;
}

/** Parsed rules of every known .gitignore. The key is the directory of the
 *  file relative to the root ("/"-separated; "" is the root itself). */
export type GitignoreRules = Map<string, GitignoreRule[]>;

/** Translate one pattern segment. Wildcards stay inside one segment. */
function translateSegment(seg: string): string {
  return seg
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]");
}

/** Compile one pattern body (no "!", no trailing "/") into a path regex.
 *  Returns null for an invalid pattern; one bad line drops out alone. */
function compilePattern(body: string, anchored: boolean): RegExp | null {
  const segs = body.split("/");
  let src = "";
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const last = i === segs.length - 1;
    if (seg === "**") {
      // A lone "**" matches everything. A trailing "**" matches the
      // contents only. Any other "**" absorbs whole directories.
      if (segs.length === 1) src += ".+";
      else if (last) src += "/.*";
      else src += "(?:[^/]+/)*";
      continue;
    }
    src += translateSegment(seg);
    if (!last && segs[i + 1] !== "**") src += "/";
  }
  try {
    return new RegExp(`${anchored ? "^" : "^(?:.*/)?"}${src}$`);
  } catch {
    return null;
  }
}

/** Parse one .gitignore source into ordered rules. Comments, blank lines,
 *  and invalid patterns drop out. */
export function parseGitignore(source: string): GitignoreRule[] {
  const rules: GitignoreRule[] = [];
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith("#")) continue;
    const negated = line.startsWith("!");
    const rest = negated ? line.slice(1) : line;
    const dirOnly = rest.endsWith("/");
    const body = dirOnly ? rest.slice(0, -1) : rest;
    if (!body || body === "/") continue;
    // A "/" anywhere anchors the pattern to this directory.
    const anchored = body.includes("/");
    const stripped = anchored && body.startsWith("/") ? body.slice(1) : body;
    if (!stripped) continue;
    const re = compilePattern(stripped, anchored);
    if (re) rules.push({ negated, dirOnly, re });
  }
  return rules;
}

/** Match a root-relative POSIX path against every known rule set.
 *  Rules apply from the shallowest directory to the deepest, so a deeper
 *  .gitignore overrides a shallower one. Within one file the last
 *  matching pattern wins. Directory-only rules match the path prefixes;
 *  they never match the final file segment itself. Like Git, traversal
 *  stops at an excluded directory: nothing inside it can come back. */
export function matchGitignore(rules: GitignoreRules, posixRelPath: string): boolean {
  if (rules.size === 0 || posixRelPath.length === 0) return false;
  const segs = posixRelPath.split("/");
  // Collect the rule sets of every ancestor directory once, shallow first.
  const layers: Array<{ offset: number; rules: GitignoreRule[] }> = [];
  for (let d = 0; d < segs.length; d++) {
    const base = d === 0 ? "" : segs.slice(0, d).join("/");
    const set = rules.get(base);
    if (set) layers.push({ offset: base.length === 0 ? 0 : base.length + 1, rules: set });
  }
  if (layers.length === 0) return false;
  let ignored = false;
  for (let d = 0; d < segs.length; d++) {
    const isDir = d < segs.length - 1;
    const prefix = segs.slice(0, d + 1).join("/");
    for (const layer of layers) {
      // A rule set never matches its own directory.
      if (layer.offset >= prefix.length) continue;
      const sub = layer.offset === 0 ? prefix : prefix.slice(layer.offset);
      if (sub.length === 0) continue;
      for (const rule of layer.rules) {
        if (rule.dirOnly && !isDir) continue;
        if (rule.re.test(sub)) ignored = !rule.negated;
      }
    }
    if (ignored && isDir) return true;
  }
  return ignored;
}
