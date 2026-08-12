/**
 * Render build/icon.svg to a 1024x1024 PNG with real transparency.
 *
 * qlmanage rasterizes SVG onto a white canvas; the Dock composites that
 * white as a white box around the squircle. Chromium (Electron) renders
 * the SVG with its alpha channel intact. This script spawns a hidden
 * transparent Electron window, captures the page, and writes the PNG.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const projectRoot = join(import.meta.dirname, "..");
const outFile = process.argv[2] ?? join(projectRoot, "build", "icon-master.png");

const work = join(tmpdir(), "termina-icon-render");
mkdirSync(work, { recursive: true });

const mainJs = `
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    frame: false,
    transparent: true,
    webPreferences: { offscreen: true, backgroundThrottling: false },
  });
  await win.loadURL("file://${join(projectRoot, "build", "icon.svg")}");
  await new Promise((r) => setTimeout(r, 400));
  const image = await win.webContents.capturePage();
  fs.writeFileSync(${JSON.stringify(outFile)}, image.toPNG());
  app.exit(0);
});
`;
writeFileSync(join(work, "main.js"), mainJs);

const child = spawn(electronPath, [join(work, "main.js")], { stdio: "inherit" });
await new Promise((resolve, reject) => {
  child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`icon render exited ${code}`))));
  child.on("error", reject);
});
rmSync(work, { recursive: true, force: true });
console.log(`✓ ${outFile}`);
