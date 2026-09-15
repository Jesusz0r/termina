/**
 * Shared ignore rules for the project watcher and agent-core walks.
 *
 * One pattern compiler. Walkers load .gitignore files; this module only
 * parses and matches. Escaped literals such as a leading "\!" stay
 * unsupported, as do bracket character classes ("[" is a literal).
 *
 * Matching is bounded by construction: segments use a two-pointer glob
 * scan (no nested backtracking quantifiers) and multi-segment patterns
 * memoize on (pattern, path) positions, so a hostile .gitignore line can
 * neither stall the main event loop nor blow the stack. Absurdly long
 * lines drop out like invalid patterns.
 */
export const IGNORED_SEGMENTS = new Set([
  "node_modules",
  ".git",
  ".pi",
  ".agents",
  ".next",
  ".nuxt",
  ".cache",
  ".e2e-tmp",
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

/** One segment of a compiled pattern body. A full "**" segment absorbs whole
 *  directories; any other segment is a glob ("*", "?") matched literally. */
type GitignoreSegment = { globstar: true } | { globstar: false; source: string };

/** One compiled pattern line of a .gitignore file. */
export interface GitignoreRule {
  /** True for a "!" pattern. A match re-includes the path. */
  negated: boolean;
  /** True for a pattern with a trailing "/". Only directories match. */
  dirOnly: boolean;
  /** True when the pattern contains a "/": it anchors to the .gitignore directory. */
  anchored: boolean;
  /** Body segments. Unanchored rules hold exactly one non-globstar segment,
   *  except a lone "**" which matches everything. */
  segments: GitignoreSegment[];
}

/** Parsed rules of every known .gitignore. The key is the directory of the
 *  file relative to the root ("/"-separated; "" is the root itself). */
export type GitignoreRules = Map<string, GitignoreRule[]>;

/** Lines past this length drop out: no legitimate ignore line is this long,
 *  and it bounds memoized match state per rule. */
const MAX_PATTERN_CHARS = 4096;

/** Compile one pattern body (no "!", no trailing "/") into segments.
 *  Returns null for an invalid or absurd pattern; one bad line drops out alone. */
function compilePattern(body: string): GitignoreSegment[] | null {
  if (body.length === 0 || body.length > MAX_PATTERN_CHARS) return null;
  const segments: GitignoreSegment[] = [];
  for (const seg of body.split("/")) {
    if (seg === "**") segments.push({ globstar: true });
    else segments.push({ globstar: false, source: seg });
  }
  return segments;
}

/**
 * Glob-match one segment ("*" any run, "?" one char) with the classic
 * two-pointer scan: backtracking returns only to the last star, so cost
 * stays quadratic in the worst case instead of exponential like a naive
 * `[^/]*`-per-star regex expansion.
 */
function matchSegment(pattern: string, name: string): boolean {
  let px = 0;
  let nx = 0;
  let star = -1;
  let mark = 0;
  while (nx < name.length) {
    if (px < pattern.length && (pattern[px] === "?" || pattern[px] === name[nx])) {
      px++;
      nx++;
    } else if (px < pattern.length && pattern[px] === "*") {
      star = px++;
      mark = nx;
    } else if (star !== -1) {
      px = star + 1;
      nx = ++mark;
    } else {
      return false;
    }
  }
  while (px < pattern.length && pattern[px] === "*") px++;
  return px === pattern.length;
}

/**
 * Match compiled segments against one relative path. Unanchored rules match
 * the basename only (equivalent to Git's any-depth suffix match for a
 * slash-free pattern). A mid-pattern "**" absorbs zero or more segments; a
 * trailing "**" requires at least one, so `cache/**` matches the contents
 * but not the directory itself. Memoized on (pattern, path) positions, so
 * repeated globstars cannot cause exponential backtracking.
 */
function matchCompiledRule(rule: GitignoreRule, posixRel: string): boolean {
  const pathSegs = posixRel.split("/");
  if (!rule.anchored) {
    const only = rule.segments[0]!;
    if (only.globstar) return true;
    return matchSegment(only.source, pathSegs[pathSegs.length - 1]!);
  }
  const segments = rule.segments;
  // Fast path: no globstar means a pairwise segment match, no state at all.
  if (!segments.some((seg) => seg.globstar)) {
    if (segments.length !== pathSegs.length) return false;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!;
      if (!seg.globstar && !matchSegment(seg.source, pathSegs[i]!)) return false;
    }
    return true;
  }
  const memo = new Map<number, boolean>();
  const stride = pathSegs.length + 1;
  const match = (pi: number, si: number): boolean => {
    const key = pi * stride + si;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let out = false;
    if (pi === segments.length) {
      out = si === pathSegs.length;
    } else {
      const seg = segments[pi]!;
      if (seg.globstar) {
        if (pi === segments.length - 1) {
          // Trailing "**": contents only, never the directory itself.
          out = si < pathSegs.length;
        } else {
          out = match(pi + 1, si) || (si < pathSegs.length && match(pi, si + 1));
        }
      } else {
        out = si < pathSegs.length && matchSegment(seg.source, pathSegs[si]!) && match(pi + 1, si + 1);
      }
    }
    memo.set(key, out);
    return out;
  };
  return match(0, 0);
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
    const segments = compilePattern(stripped);
    if (segments) rules.push({ negated, dirOnly, anchored, segments });
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
        if (matchCompiledRule(rule, sub)) ignored = !rule.negated;
      }
    }
    if (ignored && isDir) return true;
  }
  return ignored;
}
