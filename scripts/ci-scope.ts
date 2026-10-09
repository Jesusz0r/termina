import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "../shared/guards.ts";

export function selectCiScope(paths: readonly string[]): "content" | "full" {
  const contentOnly = paths.length > 0 && paths.every((path) => {
    if (path.split("/").some((part) => part === ".." || part === ".")) return false;
    return (path.startsWith("docs/") && path.endsWith(".md"))
      || path.startsWith("website/")
      || ["README.md", "CONTRIBUTING.md", "RELEASING.md"].includes(path);
  });
  return contentOnly ? "content" : "full";
}

function scopeForEvent(): "content" | "full" {
  const event: unknown = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH!, "utf8"));
  if (!isRecord(event)) return "full";
  let base: unknown;
  if (process.env.GITHUB_EVENT_NAME === "push") base = event.before;
  else if (process.env.GITHUB_EVENT_NAME === "pull_request" && isRecord(event.pull_request)
    && isRecord(event.pull_request.base)) base = event.pull_request.base.sha;
  if (typeof base !== "string" || !/^[a-f0-9]{40}$/.test(base) || /^0+$/.test(base)) return "full";
  // Include deleted paths and both rename endpoints. Diff the actual checkout,
  // including the test merge commit on pull requests.
  const diff = execFileSync("git", ["diff", "--name-only", "--no-renames", "-z", base, "HEAD", "--"], {
    encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
  });
  return selectCiScope(diff.split("\0").filter(Boolean));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  let scope: "content" | "full" = "full";
  try {
    scope = scopeForEvent();
  } catch {
    console.warn("Cannot establish the changed files; using full CI coverage.");
  }
  if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required");
  appendFileSync(process.env.GITHUB_OUTPUT, `scope=${scope}\n`);
  console.log(`CI coverage: ${scope}`);
}
