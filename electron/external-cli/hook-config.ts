/**
 * JSON hook documents shared by CLIs that install a command list.
 * Each CLI owns which events it registers and where the file lives.
 */
import { readFile } from "node:fs/promises";
import { errorCode, isRecord } from "../../shared/guards.ts";
import { durableAtomicWrite } from "../../shared/durable-write.ts";

export const HOOK_SCRIPT_NAME = "external-hook.mjs";

function commandGroup(command: string, timeout: number, name?: string): Record<string, unknown> {
  return {
    hooks: [{
      ...(name ? { name } : {}),
      type: "command",
      command,
      timeout,
    }],
  };
}

export function hookConfig(events: readonly string[], command: string, timeout: number, name?: string): Record<string, unknown> {
  const hooks: Record<string, unknown> = {};
  for (const event of events) hooks[event] = [commandGroup(command, timeout, name)];
  return { hooks };
}

function withoutTerminaHooks(existing: Record<string, unknown>): Record<string, unknown> {
  const hooks: Record<string, unknown> = {};
  for (const [event, groups] of Object.entries(existing)) {
    if (!Array.isArray(groups)) {
      hooks[event] = groups;
      continue;
    }
    const kept = groups.filter((group) => !JSON.stringify(group).includes(HOOK_SCRIPT_NAME));
    if (kept.length > 0) hooks[event] = kept;
  }
  return hooks;
}

export function mergeHookEvents(
  existing: unknown,
  events: readonly string[],
  command: string,
  timeout: number,
  name?: string,
): Record<string, unknown> {
  const hooks = withoutTerminaHooks(isRecord(existing) ? existing : {});
  for (const event of events) {
    const groups = Array.isArray(hooks[event]) ? [...hooks[event]] : [];
    groups.push(commandGroup(command, timeout, name));
    hooks[event] = groups;
  }
  return hooks;
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  const next = `${JSON.stringify(value, null, 2)}\n`;
  try {
    if (await readFile(path, "utf8") === next) return;
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  await durableAtomicWrite(path, next);
}

export async function readJsonObject(path: string, invalid: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isRecord(parsed)) throw new Error(invalid);
    return parsed;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}
