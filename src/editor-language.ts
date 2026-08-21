/** Monaco language id for a file path. */
export function languageForPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
    js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
    json: "json", jsonc: "json",
    html: "html", htm: "html",
    css: "css", scss: "scss", less: "less",
    md: "markdown",
    py: "python",
    rb: "ruby",
    go: "go",
    rs: "rust",
    java: "java",
    c: "c", h: "c", cpp: "cpp", hpp: "cpp", cc: "cpp",
    cs: "csharp",
    php: "php",
    sh: "shell", bash: "shell", zsh: "shell",
    yml: "yaml", yaml: "yaml",
    toml: "ini",
    sql: "sql",
    xml: "xml", svg: "xml",
    vue: "html",
    swift: "swift",
    kt: "kotlin",
    dart: "dart",
  };
  return map[ext] ?? "plaintext";
}
