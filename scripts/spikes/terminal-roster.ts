import {
  composeTerminalRoster,
  MAX_TERMINAL_ROSTER,
  parseTerminalRoster,
} from "../../electron/terminal-roster.js";

export default function run(log: (message: string) => void): void {
  const check = (name: string, ok: boolean): void => {
    if (!ok) throw new Error(name);
    log(`PASS ${name}`);
  };

  const parsed = parseTerminalRoster({
    terminals: [
      { id: "term-2", type: "agent", sessionId: "session-2", sessionFile: "/tmp/session-2.jsonl" },
      { id: "term-2", type: "shell", shell: "/bin/zsh" },
      { id: "../bad", type: "agent" },
    ],
  });
  check("parse valid roster entry", parsed.length === 1 && parsed[0]?.sessionId === "session-2");
  check("reject relative session file", parseTerminalRoster([{ id: "term-1", type: "agent", sessionFile: "x.jsonl" }])[0]?.sessionFile == null);

  const live = [{ id: "term-3", type: "agent" as const }];
  const unrestored = [
    { id: "term-1", type: "agent" as const },
    { id: "term-3", type: "shell" as const, shell: "/bin/zsh" },
  ];
  const composed = composeTerminalRoster(live, unrestored);
  check("prefer live duplicate", composed.length === 2 && composed[0]?.type === "agent");
  const many = Array.from({ length: 20 }, (_, index) => ({ id: `term-${index + 1}`, type: "agent" as const }));
  check("cap roster", composeTerminalRoster(many, []).length === MAX_TERMINAL_ROSTER);
}
