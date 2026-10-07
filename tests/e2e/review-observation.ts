import type { Page } from "@playwright/test";
import type { ProjectWorkspaceRef } from "../../shared/types.ts";

interface ReviewObservation {
  done: Promise<void>;
  off(): void;
}

/** Arm before a fixture write; wait for main's real asynchronous source notifications. */
export async function observeReviewWrites(page: Page, owner: ProjectWorkspaceRef, files: Record<string, string>): Promise<() => Promise<void>> {
  await page.evaluate(({ owner, files }) => {
    const w = window as unknown as { __reviewObservation: ReviewObservation };
    let finish!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    const expected = new Map(Object.entries(files));
    const off = window.termina.onFileChanged((event) => {
      if (event.projectId !== owner.projectId || event.workspaceId !== owner.workspaceId
        || !expected.has(event.relPath) || expected.get(event.relPath) !== event.content) return;
      expected.delete(event.relPath);
      if (!expected.size) { off(); finish(); }
    });
    w.__reviewObservation = { done, off };
  }, { owner, files });
  return async () => {
    await page.evaluate(async () => {
      const w = window as unknown as { __reviewObservation?: ReviewObservation };
      const observation = w.__reviewObservation!;
      try { await observation.done; }
      finally { observation.off(); delete w.__reviewObservation; }
    });
  };
}
