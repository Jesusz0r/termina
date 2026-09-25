/**
 * Terminal hyperlinks shared by the agent TUI and the xterm link handler.
 * http(s) opens in the browser. Any other markdown target that looks like a
 * file is carried as a file URI the editor can open.
 */

const WEB_URL = /^https?:\/\/\S+$/i;
const HOST_PORT = /^(?:localhost|127\.0\.0\.1):\d{2,5}(?:\/\S*)?$/i;

const KNOWN_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs",
  "rs", "py", "go", "java", "c", "cpp", "cc", "cxx", "h", "hpp", "cs", "rb", "php", "swift", "kt", "scala",
  "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd",
  "json", "jsonl", "json5", "yaml", "yml", "toml", "html", "htm", "css", "scss", "sass", "less", "sql",
  "md", "markdown", "mdx", "txt", "xml", "svg", "env", "lock",
  "vue", "svelte", "astro", "graphql", "gql", "proto", "ini", "cfg", "conf", "diff", "patch",
  "log", "csv", "tsv",
]);

const KNOWN_FILENAMES = new Set([
  "dockerfile", "makefile", "gemfile", "rakefile", "cmakelists.txt", "license", "licence", "readme",
  ".gitignore", ".gitattributes", ".editorconfig", ".env", ".npmrc", ".prettierrc", ".eslintrc",
  "cargo.toml", "cargo.lock", "package.json", "pnpm-lock.yaml", "tsconfig.json",
]);

/** Drop sentence punctuation. A trailing `)` stays when it closes a parenthesis in the URL. */
function stripTrailingPunctuation(value: string): string {
  let opens = 0;
  let closes = 0;
  for (const ch of value) {
    if (ch === "(") opens += 1;
    else if (ch === ")") closes += 1;
  }
  while (value.length > 0 && !value.endsWith("://")) {
    const last = value[value.length - 1]!;
    if (/[.,;!?:]/.test(last) || (last === ")" && closes > opens)) {
      value = value.slice(0, -1);
      if (last === ")") closes -= 1;
      continue;
    }
    break;
  }
  return value;
}

/** An http(s) URL with no credentials, or null. `localhost:3000` is treated as http. */
export function terminalWebUrl(raw: string): string | null {
  let value = stripTrailingPunctuation(raw.trim());
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) return null;
  if (HOST_PORT.test(value)) value = `http://${value}`;
  if (!WEB_URL.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** True when a cleaned path is a source file the editor can open. */
export function isRecognizedTerminalPath(cleanPath: string): boolean {
  const baseName = cleanPath.split("/").pop()?.split("\\").pop() ?? "";
  const dotIdx = baseName.lastIndexOf(".");
  const ext = dotIdx > 0 ? baseName.slice(dotIdx + 1).toLowerCase() : "";
  const hasDirectory = cleanPath.includes("/") || cleanPath.includes("\\");
  return (
    (ext !== "" && KNOWN_EXTENSIONS.has(ext)) ||
    KNOWN_FILENAMES.has(baseName.toLowerCase()) ||
    (hasDirectory && ext.length >= 1 && ext.length <= 10 && /^[a-zA-Z0-9]+$/.test(ext))
  );
}

/** OSC 8 URI for a markdown target, or null when the target is not a link. */
export function terminalOscUri(target: string): string | null {
  const web = terminalWebUrl(target);
  if (web) return web;
  const file = target.trim();
  if (!file || file.length > 1024 || /[\u0000-\u001f\u007f\s]/.test(file)) return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(file)) return null;
  const pathOnly = file.replace(/#L\d+(?:-L?\d+)?$/, "").replace(/:\d+(?::\d+)?$/, "").replace(/\(\d+(?:,\s*\d+)?\)$/, "");
  if (!isRecognizedTerminalPath(pathOnly)) return null;
  return `file://termina.local/?target=${encodeURIComponent(file)}`;
}

/** File target carried in an OSC 8 URI this app painted, or null. */
export function terminalOscFileTarget(uri: string): string | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  if (url.protocol !== "file:" || url.hostname !== "termina.local") return null;
  const target = url.searchParams.get("target");
  if (!target || /[\u0000-\u001f\u007f]/.test(target)) return null;
  return target;
}
