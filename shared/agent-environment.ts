/**
 * Consume launch-only session bindings before tools or extensions spawn children.
 * The process-local copy survives Pi extension reloads, but cannot be inherited
 * by a subprocess. Keep this function self-contained: the app embeds it in the
 * standalone Pi bridge, which cannot import files from the app bundle.
 */
export function consumeAgentSessionEnvironment(): Readonly<Record<string, string | undefined>> {
  const key = Symbol.for("termina.agentSessionEnvironment");
  const state = process as typeof process & { [key: symbol]: Readonly<Record<string, string | undefined>> | undefined };
  const names = [
    "TERMINA_EVENTS_DIR",
    "TERMINA_TERMINAL_ID",
    "TERMINA_CORE_SESSION_ID",
    "TERMINA_CORE_SESSION_FILE",
    "TERMINA_CORE_RESUME",
  ];
  const captured: Record<string, string | undefined> = {};
  for (const name of names) {
    captured[name] = process.env[name];
    delete process.env[name];
  }
  if (!state[key] && names.some((name) => captured[name] !== undefined)) {
    state[key] = Object.freeze(captured);
  }
  return state[key] ?? captured;
}
