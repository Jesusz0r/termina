import { isAbsolute, relative, sep } from "node:path";

export interface SourceClaim {
  readonly id: string;
  readonly generation: number;
  readonly root: string;
  readonly groupId: string;
  readonly kind: "agent" | "shell";
  /** Only the core's enforced observational run scope may request this. */
  readonly access?: "read";
}

export function sourceTreesOverlap(a: string, b: string): boolean {
  const inside = (parent: string, child: string): boolean => {
    const path = relative(parent, child);
    return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
  };
  return inside(a, b) || inside(b, a);
}

interface Reservation {
  claim: SourceClaim;
  phase: "pending" | "live" | "retained";
  priorLive: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

export class SourceAdmissions {
  private readonly reservations = new Map<string, Reservation>();

  constructor(
    private readonly hasChildren: (id: string) => boolean,
    private readonly onExpired: (claim: SourceClaim) => void,
  ) {}

  admit(claim: SourceClaim): { ok: true } | { ok: false; conflict: SourceClaim } {
    const key = this.key(claim.id, claim.generation);
    const previous = this.reservations.get(key);
    if (previous && (previous.claim.root !== claim.root || previous.claim.groupId !== claim.groupId
      || previous.claim.access !== claim.access)) {
      return { ok: false, conflict: previous.claim };
    }
    for (const record of this.reservations.values()) {
      if (record === previous) continue;
      if (sourceTreesOverlap(record.claim.root, claim.root)
        && record.claim.access !== "read" && claim.access !== "read"
        && !(claim.groupId !== "" && record.claim.groupId === claim.groupId)) {
        return { ok: false, conflict: record.claim };
      }
    }
    if (previous) clearTimeout(previous.timer);
    const record: Reservation = {
      claim,
      phase: "pending",
      priorLive: previous?.phase === "live" || previous?.priorLive === true,
    };
    this.reservations.set(key, record);
    record.timer = setTimeout(() => {
      if (this.reservations.get(key) !== record || record.phase !== "pending") return;
      this.finish(claim.id, claim.generation);
      this.onExpired(claim);
    }, 60_000);
    return { ok: true };
  }

  start(id: string, generation: number): void {
    const record = this.reservations.get(this.key(id, generation));
    if (!record) return;
    clearTimeout(record.timer);
    record.timer = undefined;
    record.phase = "live";
    record.priorLive = false;
  }

  finish(id: string, generation: number): void {
    const key = this.key(id, generation);
    const record = this.reservations.get(key);
    if (!record) return;
    clearTimeout(record.timer);
    record.timer = undefined;
    // Failed preparation must not release a run that was live before re-admission.
    if (record.phase === "pending" && record.priorLive) {
      record.phase = "live";
      record.priorLive = false;
    } else if (this.hasChildren(id)) {
      record.phase = "retained";
    } else {
      this.reservations.delete(key);
    }
  }

  releaseRetained(id: string): void {
    if (this.hasChildren(id)) return;
    for (const [key, record] of this.reservations) {
      if (record.claim.id === id && record.phase === "retained") this.reservations.delete(key);
    }
  }

  remove(id: string, generation: number): void {
    const key = this.key(id, generation);
    clearTimeout(this.reservations.get(key)?.timer);
    this.reservations.delete(key);
  }

  writerAt(root: string): SourceClaim | null {
    for (const { claim } of this.reservations.values()) {
      if (claim.access !== "read" && sourceTreesOverlap(root, claim.root)) return claim;
    }
    return null;
  }

  ownsWrite(id: string, generation: number, path: string): boolean {
    const record = this.reservations.get(this.key(id, generation));
    if (!record || (record.phase === "pending" && !record.priorLive)) return false;
    return record.claim.access !== "read" && sourceTreesOverlap(record.claim.root, path);
  }

  dispose(): void {
    for (const record of this.reservations.values()) clearTimeout(record.timer);
    this.reservations.clear();
  }

  private key(id: string, generation: number): string {
    return JSON.stringify([id, generation]);
  }
}
