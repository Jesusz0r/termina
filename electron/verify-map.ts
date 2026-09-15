/**
 * One-ticket-one-run map (#237).
 *
 * A verify run id maps to at most one finding ticket. A second ticket
 * that cites the same run fails closed. The same ticket may cite the
 * same run again.
 *
 * Finding tickets are audit/session identities, not `verify:run` IPC.
 * Main has no ticket store; do not grow one here. Callers cite through
 * this map. The in-memory table is process-local.
 */
type VerifyCiteOk = {
  readonly ok: true;
  readonly verifyRunId: string;
  readonly ticketId: string;
};

type VerifyCiteConflict = {
  readonly ok: false;
  readonly error: string;
  readonly verifyRunId: string;
  readonly ticketId: string;
  readonly existingTicketId: string;
};

type VerifyCiteResult = VerifyCiteOk | VerifyCiteConflict;

interface VerifyMap {
  cite(verifyRunId: string, ticketId: string): VerifyCiteResult;
  ticketFor(verifyRunId: string): string | null;
}

function requiredId(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function createVerifyMap(): VerifyMap {
  const cited = new Map<string, string>();
  return {
    cite(verifyRunId, ticketId) {
      const run = requiredId(verifyRunId);
      const ticket = requiredId(ticketId);
      if (run === null) {
        return {
          ok: false,
          error: "verify run id is required",
          verifyRunId,
          ticketId,
          existingTicketId: "",
        };
      }
      if (ticket === null) {
        return {
          ok: false,
          error: "ticket id is required",
          verifyRunId,
          ticketId,
          existingTicketId: "",
        };
      }
      const existing = cited.get(run);
      if (existing === undefined) {
        cited.set(run, ticket);
        return { ok: true, verifyRunId: run, ticketId: ticket };
      }
      if (existing === ticket) return { ok: true, verifyRunId: run, ticketId: ticket };
      return {
        ok: false,
        error: `verify run already closes ticket ${existing}`,
        verifyRunId: run,
        ticketId: ticket,
        existingTicketId: existing,
      };
    },
    ticketFor(verifyRunId) {
      const run = requiredId(verifyRunId);
      return run === null ? null : cited.get(run) ?? null;
    },
  };
}
