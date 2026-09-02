export function e2ePort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.TERMINA_E2E_PORT;
  if (typeof raw !== "string" || !/^[1-9][0-9]{0,4}$/.test(raw)) {
    throw new Error("TERMINA_E2E_PORT must be an integer from 1 to 65535");
  }
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port > 65_535) {
    throw new Error("TERMINA_E2E_PORT must be an integer from 1 to 65535");
  }
  return port;
}
