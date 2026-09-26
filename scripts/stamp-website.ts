/**
 * Write package.json's version into the static site.
 *
 * The pages workflow runs this before upload. The HTML keeps `__VERSION__`
 * so the badge and download URLs cannot drift from the release tag.
 */
import { readFileSync, writeFileSync } from "node:fs";

const version = JSON.parse(readFileSync("package.json", "utf8")).version;
if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error(`package.json version is not a release version: ${String(version)}`);
}

const files = ["website/index.html", "website/guide.html"];
for (const file of files) {
  const text = readFileSync(file, "utf8");
  if (!text.includes("__VERSION__")) throw new Error(`${file} has no __VERSION__ token`);
  writeFileSync(file, text.replaceAll("__VERSION__", version));
}
