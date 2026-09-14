/**
 * Owned teardown for Phase 0 spikes (issue #135).
 *
 * Spikes allocate fixture roots and spawn core children; a mid-run throw
 * must not leak either. Spikes register what they own; the spike runner
 * disposes everything in its finally — tracked children are stopped and
 * awaited before their fixture roots are removed. Cleanup is
 * identity-bound: only registered roots are removed and only registered
 * children are signalled. Never broad pkill, never arbitrary sleeps.
 *
 * The runner bundles each spike with esbuild, so the runner and the spike
 * load separate copies of this module. The registry lives on globalThis
 * under a shared symbol so tracking (in the bundle) and disposal (in the
 * runner) meet in one place.
 *
 * The shared CoreClient child is process-scoped and dies with the spike
 * process; only per-request raw children are tracked here.
 */
import { rmSync } from "node:fs";
import type { ChildProcess } from "node:child_process";

type SpikeRegistry = {
  roots: Set<string>;
  children: Set<ChildProcess>;
};

const REGISTRY_KEY = Symbol.for("termina.spike-resources");

function registry(): SpikeRegistry {
  const globals = globalThis as unknown as Record<symbol, SpikeRegistry | undefined>;
  const existing = globals[REGISTRY_KEY];
  if (existing) return existing;
  const fresh: SpikeRegistry = { roots: new Set(), children: new Set() };
  globals[REGISTRY_KEY] = fresh;
  return fresh;
}

/** Register a fixture root for runner-owned removal. Returns the root. */
export function trackSpikeFixtureRoot(root: string): string {
  registry().roots.add(root);
  return root;
}

/** Register a raw core child for runner-owned settle. Returns the child. */
export function trackSpikeChild<T extends ChildProcess>(child: T): T {
  const tracked = registry().children;
  tracked.add(child);
  child.once("close", () => {
    tracked.delete(child);
  });
  return child;
}

function exited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/**
 * Stop one owned child and wait for it to exit. SIGTERM first with a
 * bounded close wait, then SIGKILL with a second bounded wait. Resolves
 * even if the child outlives both so teardown cannot hang the runner.
 */
export async function settleSpikeChild(child: ChildProcess, graceMs = 5_000): Promise<void> {
  if (!exited(child)) {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
    await waitForClose(child, graceMs);
  }
  if (!exited(child)) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    await waitForClose(child, graceMs);
  }
}

function waitForClose(child: ChildProcess, budgetMs: number): Promise<void> {
  if (exited(child)) return Promise.resolve();
  return new Promise((resolve) => {
    const deadline = Date.now() + Math.max(0, budgetMs);
    const timer = setInterval(() => {
      if (exited(child) || Date.now() >= deadline) {
        clearInterval(timer);
        resolve();
      }
    }, 25);
    child.once("close", () => {
      clearInterval(timer);
      resolve();
    });
  });
}

/**
 * Stop and await every tracked child, then remove every tracked root.
 * Idempotent: drained entries are forgotten, and removal is forced.
 */
export async function disposeSpikeResources(): Promise<void> {
  const tracked = registry();
  const children = [...tracked.children];
  tracked.children.clear();
  await Promise.all(children.map((child) => settleSpikeChild(child)));
  const roots = [...tracked.roots];
  tracked.roots.clear();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
}
