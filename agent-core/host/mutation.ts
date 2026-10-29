/** One host lease per action. Detaching never widens the terminal's permissions. */
import { randomUUID } from "node:crypto";
import { waitForAck } from "./context.ts";

export async function admitHostMutation(options: {
  eventsDir: string;
  terminalId: string;
  bridgeId: string;
  shouldStop: () => boolean;
  confirmDetached: () => Promise<boolean>;
  logEvent: (event: { t: "mutation_request" | "mutation_finished"; requestId: string }) => void;
}): Promise<{ ok: true; finish: () => void } | { ok: false; error: string }> {
  const request = async () => {
    const requestId = randomUUID();
    const finish = () => options.logEvent({ t: "mutation_finished", requestId });
    options.logEvent({ t: "mutation_request", requestId });
    const ack = await waitForAck(options.eventsDir, options.terminalId, requestId, 15_000, options.bridgeId, options);
    if (ack?.ok !== true) finish();
    return { ack, finish };
  };
  let admitted = await request();
  if (admitted.ack?.needsApproval === true && !options.shouldStop() && await options.confirmDetached()) {
    admitted = await request();
  }
  if (admitted.ack?.ok === true && !options.shouldStop()) return { ok: true, finish: admitted.finish };
  if (admitted.ack?.ok === true) admitted.finish();
  return { ok: false, error: typeof admitted.ack?.error === "string" ? admitted.ack.error : "host did not admit this action" };
}
