import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppPreferencesStore } from "../../../electron/preferences.ts";
import { normalizeAppPreferences, normalizeUserPreferencePatch } from "../../../shared/preferences.ts";
import { HIDE_THINKING_CSI, SHOW_THINKING_CSI } from "../../../shared/terminal-control.ts";
import type { AppPreferences } from "../../../shared/types.ts";
import ts from "typescript";

/**
 * Corrupt-prefs confirm flow of TerminaApp.updatePreferences, extracted from
 * electron/main.ts (the save-revert-lease suite's pattern: main imports
 * Electron and cannot be imported here). Uses the real AppPreferencesStore
 * against temp files, so the refuse/replace boundary is exercised for real:
 * a damaged file must prompt, replace only on confirm, and never go
 * permanently unwritable.
 */

const root = process.cwd();
const main = readFileSync(join(root, "electron", "main.ts"), "utf8");

function extractMethod(source: string, signature: string): string {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error(`missing method ${signature}`);
  const paramsEnd = source.indexOf(")", start + signature.length) + 1;
  let angle = 0;
  let brace = -1;
  for (let i = paramsEnd; i < source.length; i++) {
    const ch = source[i];
    if (ch === "<") angle++;
    else if (ch === ">" && angle > 0) angle--;
    else if (ch === "{" && angle === 0) {
      brace = i;
      break;
    }
  }
  if (brace < 0) throw new Error(`unclosed method ${signature}`);
  let depth = 0;
  for (let i = brace; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unclosed method ${signature}`);
}

function loadMethod(factoryName: string, signature: string, names: string[], values: unknown[]): unknown {
  const methodSource = extractMethod(main, signature).replace(/^private /, "");
  const factory = ts.transpileModule(`return ({ ${methodSource} }).${factoryName};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const construct = new Function(...names, factory) as unknown as (...args: unknown[]) => unknown;
  return construct(...values);
}

type UpdatePreferences = (raw: unknown, activateShortcuts: boolean) => Promise<AppPreferences>;
type CommitPreferencePatch = (
  patch: Partial<AppPreferences>,
  activateShortcuts: boolean,
  confirmReset?: boolean,
) => Promise<AppPreferences>;
type IsPrefsResetRefusal = (err: unknown) => boolean;
type ConfirmPrefsReset = () => Promise<boolean>;

const realUpdate = loadMethod(
  "updatePreferences",
  "private async updatePreferences(",
  ["normalizeUserPreferencePatch"],
  [normalizeUserPreferencePatch],
) as UpdatePreferences;

const realCommit = loadMethod(
  "commitPreferencePatch",
  "private async commitPreferencePatch(",
  ["normalizeAppPreferences", "nativeTheme", "SHOW_THINKING_CSI", "HIDE_THINKING_CSI"],
  [normalizeAppPreferences, { themeSource: "" }, SHOW_THINKING_CSI, HIDE_THINKING_CSI],
) as CommitPreferencePatch;

const realIsRefusal = loadMethod(
  "isPrefsResetRefusal",
  "private isPrefsResetRefusal(",
  [],
  [],
) as IsPrefsResetRefusal;

function loadConfirm(dialog: unknown): ConfirmPrefsReset {
  return loadMethod("confirmPrefsReset", "private async confirmPrefsReset(", ["dialog"], [dialog]) as ConfirmPrefsReset;
}

interface PrefsHarness {
  app: Record<string, unknown>;
  dialogCalls: unknown[][];
}

function makePrefsApp(
  store: AppPreferencesStore,
  prefs: AppPreferences,
  opts: { dialogResponse?: number; win?: unknown } = {},
): PrefsHarness {
  const dialogCalls: unknown[][] = [];
  const dialog = {
    showMessageBox: async (...args: unknown[]) => {
      dialogCalls.push(args);
      return { response: opts.dialogResponse ?? 1 };
    },
  };
  const app: Record<string, unknown> = {
    preferencesStore: store,
    preferences: prefs,
    preferenceCommits: Promise.resolve(),
    shortcutMap: {},
    buildMenu: () => undefined,
    terminals: new Map(),
    win: opts.win === undefined ? { isDestroyed: () => false } : opts.win,
  };
  const confirm = loadConfirm(dialog);
  app.commitPreferencePatch = (...args: unknown[]) =>
    (realCommit as (...a: unknown[]) => unknown).call(app, ...args);
  app.isPrefsResetRefusal = (...args: unknown[]) =>
    (realIsRefusal as (...a: unknown[]) => unknown).call(app, ...args);
  app.confirmPrefsReset = (...args: unknown[]) =>
    (confirm as (...a: unknown[]) => unknown).call(app, ...args);
  return { app, dialogCalls };
}

let dir = "";
let filePath = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "termina-prefs-confirm-"));
  filePath = join(dir, "preferences.json");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("corrupt prefs confirm flow", () => {
  it("prompts on a corrupt file and replaces only on confirm", async () => {
    const corrupt = "{not-json";
    await writeFile(filePath, corrupt, "utf8");
    const store = new AppPreferencesStore(filePath);
    const { app, dialogCalls } = makePrefsApp(store, await store.load(), { dialogResponse: 0 });
    const saved = await realUpdate.call(app, { patch: { theme: "light" }, activateShortcuts: false }, false);
    expect(saved.theme).toBe("light");
    expect(dialogCalls).toHaveLength(1);
    expect(dialogCalls[0]?.[1]).toMatchObject({
      type: "warning",
      buttons: ["Reset to defaults", "Cancel"],
    });
    expect(JSON.parse(await readFile(filePath, "utf8")).theme).toBe("light");
    // The reset cleared the refusal: the next write needs no confirm.
    const again = await realUpdate.call(app, { patch: { theme: "atom" }, activateShortcuts: false }, false);
    expect(again.theme).toBe("atom");
    expect(dialogCalls).toHaveLength(1);
  });

  it("leaves the damaged file alone when the user cancels", async () => {
    const corrupt = "{not-json";
    await writeFile(filePath, corrupt, "utf8");
    const store = new AppPreferencesStore(filePath);
    const { app, dialogCalls } = makePrefsApp(store, await store.load(), { dialogResponse: 1 });
    const raw = { patch: { theme: "light" }, activateShortcuts: false };
    await expect(realUpdate.call(app, raw, false)).rejects.toThrow(/until reset is confirmed/);
    expect(await readFile(filePath, "utf8")).toBe(corrupt);
    // Still refused, and asks again instead of silently replacing.
    await expect(realUpdate.call(app, raw, false)).rejects.toThrow(/until reset is confirmed/);
    expect(dialogCalls).toHaveLength(2);
    expect(await readFile(filePath, "utf8")).toBe(corrupt);
  });

  it("refuses without prompting when headless", async () => {
    const corrupt = "{not-json";
    await writeFile(filePath, corrupt, "utf8");
    const store = new AppPreferencesStore(filePath);
    const { app, dialogCalls } = makePrefsApp(store, await store.load(), { win: null });
    await expect(
      realUpdate.call(app, { patch: { theme: "light" }, activateShortcuts: false }, false),
    ).rejects.toThrow(/until reset is confirmed/);
    expect(dialogCalls).toHaveLength(0);
    expect(await readFile(filePath, "utf8")).toBe(corrupt);
  });

  it("saves a healthy file without prompting", async () => {
    const store = new AppPreferencesStore(filePath);
    const { app, dialogCalls } = makePrefsApp(store, await store.load());
    const saved = await realUpdate.call(app, { patch: { theme: "light" }, activateShortcuts: false }, false);
    expect(saved.theme).toBe("light");
    expect(dialogCalls).toHaveLength(0);
    expect(JSON.parse(await readFile(filePath, "utf8")).theme).toBe("light");
  });

  it("honors an explicit reset without prompting again", async () => {
    await writeFile(filePath, "{not-json", "utf8");
    const store = new AppPreferencesStore(filePath);
    const { app, dialogCalls } = makePrefsApp(store, await store.load());
    const saved = await realUpdate.call(
      app,
      { patch: { theme: "light" }, activateShortcuts: false, confirmReset: true },
      false,
    );
    expect(saved.theme).toBe("light");
    expect(dialogCalls).toHaveLength(0);
    expect(JSON.parse(await readFile(filePath, "utf8")).theme).toBe("light");
  });

  it("prompts on an oversized file too", async () => {
    const oversized = "x".repeat(128 * 1024 + 1);
    await writeFile(filePath, oversized, "utf8");
    const store = new AppPreferencesStore(filePath);
    const { app, dialogCalls } = makePrefsApp(store, await store.load(), { dialogResponse: 0 });
    const saved = await realUpdate.call(app, { patch: { theme: "light" }, activateShortcuts: false }, false);
    expect(saved.theme).toBe("light");
    expect(dialogCalls).toHaveLength(1);
  });

  it("matches only the reset refusal, never other failures", () => {
    expect(realIsRefusal.call(null, new Error("preferences file is unreadable — refusing to overwrite until reset is confirmed"))).toBe(true);
    expect(realIsRefusal.call(null, new Error("EACCES: permission denied"))).toBe(false);
    expect(realIsRefusal.call(null, null)).toBe(false);
  });
});
