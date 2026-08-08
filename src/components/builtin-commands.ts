/**
 * Built-in commands that pi's TUI has but RPC mode doesn't expose.
 * Backed by RPC primitives (compact, stats, export…) or native UI.
 * The renderer intercepts these in sendPrompt and never sends them to pi.
 */
import type { PiCommand, ModelInfo } from "../../shared/types";
import type { TerminalManager } from "../terminal";

interface BuiltinPane {
  models: ModelInfo[];
}

interface BuiltinContext {
  instanceId: string;
  terminal: TerminalManager;
  pane: BuiltinPane;
  openFile: (absPath: string) => Promise<void>;
}

export interface Builtin {
  name: string;
  description: string;
  run: (args: string, ctx: BuiltinContext) => Promise<void>;
}

const print = (ctx: BuiltinContext, lines: string[]): void => {
  for (const line of lines) ctx.terminal.system(line);
};

export const BUILTINS: Builtin[] = [
  {
    name: "help",
    description: "List all built-in commands",
    run: async (_args, ctx) => {
      const lines = [
        "built-in commands (implemented by pi-editor):",
        ...BUILTINS.map((b) => `  /${b.name} — ${b.description}`),
        "skills, prompt templates and extension commands:",
        "  type / and pick from the list (e.g. /skill:clean-code)",
      ];
      print(ctx, lines);
    },
  },
  {
    name: "models",
    description: "List available models for this terminal",
    run: async (_args, ctx) => {
      const models = ctx.pane.models;
      if (!models.length) {
        print(ctx, ["no models available"]);
        return;
      }
      print(ctx, [`available models (${models.length}):`, ...models.map((m) => `  ${m.name} — ${m.provider}/${m.id}`)]);
    },
  },
  {
    name: "compact",
    description: "Compact the conversation context",
    run: async (args, ctx) => {
      print(ctx, ["… compacting context…"]);
      const res = await window.pi.builtin(ctx.instanceId, "compact", args);
      if (res.ok && res.text) print(ctx, res.text.split("\n"));
      else print(ctx, [`✗ ${res.error ?? "failed"}`]);
    },
  },
  {
    name: "stats",
    description: "Show token usage and cost for this session",
    run: async (_args, ctx) => {
      const res = await window.pi.builtin(ctx.instanceId, "stats", "");
      if (res.ok && res.text) print(ctx, res.text.split("\n"));
      else print(ctx, [`✗ ${res.error ?? "failed"}`]);
    },
  },
  {
    name: "export",
    description: "Export this session to an HTML file",
    run: async (_args, ctx) => {
      const res = await window.pi.builtin(ctx.instanceId, "export", "");
      if (res.ok && res.text) print(ctx, res.text.split("\n"));
      else print(ctx, [`✗ ${res.error ?? "failed"}`]);
    },
  },
  {
    name: "session-name",
    description: "Set a display name for this session",
    run: async (args, ctx) => {
      if (!args) {
        print(ctx, ["usage: /session-name <name>"]);
        return;
      }
      const res = await window.pi.builtin(ctx.instanceId, "session-name", args);
      if (res.ok && res.text) print(ctx, [res.text]);
      else print(ctx, [`✗ ${res.error ?? "failed"}`]);
    },
  },
  {
    name: "auto-compaction",
    description: "Toggle automatic context compaction (on|off)",
    run: async (args, ctx) => {
      const res = await window.pi.builtin(ctx.instanceId, "auto-compaction", args);
      if (res.ok && res.text) print(ctx, [res.text]);
      else print(ctx, [`✗ ${res.error ?? "failed"}`]);
    },
  },
  {
    name: "auto-retry",
    description: "Toggle automatic retry on transient errors (on|off)",
    run: async (args, ctx) => {
      const res = await window.pi.builtin(ctx.instanceId, "auto-retry", args);
      if (res.ok && res.text) print(ctx, [res.text]);
      else print(ctx, [`✗ ${res.error ?? "failed"}`]);
    },
  },
  {
    name: "login",
    description: "Show which providers have credentials configured",
    run: async (_args, ctx) => {
      const { authPath } = await window.pi.configPaths();
      print(ctx, [
        "authentication is managed by pi (~/.pi/agent/auth.json)",
        `  auth file: ${authPath}`,
        "to add or refresh a provider login, run:  pi  (interactive) → /login",
      ]);
    },
  },
  {
    name: "settings",
    description: "Open pi's settings.json in the editor",
    run: async (_args, ctx) => {
      const { settingsPath } = await window.pi.configPaths();
      print(ctx, [`opening ${settingsPath} in the editor — changes apply on next terminal`]);
      await ctx.openFile(settingsPath);
    },
  },
  {
    name: "clear",
    description: "Clear the terminal screen",
    run: async (_args, ctx) => {
      ctx.terminal.getTerminal().clear();
    },
  },
];

/** Built-ins as autocomplete entries (dedupe against pi-provided names). */
export function builtinCommandEntries(existing: PiCommand[]): PiCommand[] {
  const names = new Set(existing.map((c) => c.name));
  const ours = BUILTINS.filter((b) => !names.has(b.name)).map((b) => ({
    name: b.name,
    description: b.description,
    source: "builtin",
  }));
  return [...ours, ...existing];
}

/** Resolve a prompt text to a builtin, if any. */
export function matchBuiltin(text: string): { builtin: Builtin; args: string } | null {
  if (!text.startsWith("/")) return null;
  const space = text.indexOf(" ");
  const name = space === -1 ? text.slice(1) : text.slice(1, space);
  const args = space === -1 ? "" : text.slice(space + 1).trim();
  const builtin = BUILTINS.find((b) => b.name === name);
  return builtin ? { builtin, args } : null;
}