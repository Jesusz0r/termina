/** Pick the CLI domain that installs hooks and returns launch args. */
import { EXTERNAL_CLIS, type ExternalCli } from "../../shared/types.ts";
import { prepareAgy, AGY_LAUNCH } from "./agy.ts";
import { prepareClaude, CLAUDE_LAUNCH } from "./claude.ts";
import { prepareCodex, CODEX_LAUNCH } from "./codex.ts";
import { prepareGrok, GROK_LAUNCH } from "./grok.ts";
import { prepareMuse, MUSE_LAUNCH } from "./muse.ts";
import type { CliRoots, PreparedCli } from "./types.ts";

const LAUNCH = {
  codex: CODEX_LAUNCH,
  claude: CLAUDE_LAUNCH,
  grok: GROK_LAUNCH,
  gemini: AGY_LAUNCH,
  muse: MUSE_LAUNCH,
} as const satisfies Record<ExternalCli, { bin: string; label: string }>;

const PREPARE = {
  codex: prepareCodex,
  claude: prepareClaude,
  grok: prepareGrok,
  gemini: prepareAgy,
  muse: prepareMuse,
} as const satisfies Record<ExternalCli, (command: string, roots: CliRoots) => Promise<PreparedCli>>;

export function externalCliLaunch(cli: ExternalCli): { bin: string; label: string } {
  return LAUNCH[cli];
}

/** The hook command names its CLI so a shell-started process can report activity. */
export function externalCliHookCommand(cli: ExternalCli, command: string): string {
  return `TERMINA_EXTERNAL_CLI=${cli} ${command}`;
}

export function prepareExternalCli(cli: ExternalCli, command: string, roots: CliRoots): Promise<PreparedCli> {
  return PREPARE[cli](externalCliHookCommand(cli, command), roots);
}

/** Install every CLI's hooks. A Termina shell can start any of them. */
export async function prepareInstalledExternalClis(command: string, roots: CliRoots): Promise<void> {
  for (const cli of EXTERNAL_CLIS) await prepareExternalCli(cli, command, roots);
}
