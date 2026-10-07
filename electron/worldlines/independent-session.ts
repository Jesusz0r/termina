/** Fresh user sessions reuse the candidate template, sandbox and launch owners. */
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { coreSessionFile, sessionBundleHasContent } from "../../agent-core/session.js";
import { admitWorldlineForkSource } from "./bootstrap.js";
import { probePromotionDirectory, readComparisonManifestBound, readPromotionEntry, boundPromotionExpectedLeaf } from "./promotion-recovery.js";
import { promotionIdentityOf } from "./bindings.js";
import { boundedWorldlineEntries } from "./uncertain-comparison.js";
import { MARKER, MAX_UNCERTAIN_COMPARISON_ROOT_ENTRIES, MAX_UNCERTAIN_SCAN_WORK_BYTES } from "./limits.js";
import { boundPromotionReadFile, gitHead, type SnapshotStore } from "../worldline-git.js";
import type { WorldlineDeps } from "./manager.js";
import type { BoundPromotionDirectory, ComparisonManifest, ComparisonState, UncertainComparisonAdmissionLease } from "./types.js";

export interface IndependentSessionOptions {
  model: string | null;
  thinkingLevel: string | null;
  sourceSessionFile?: string;
}

export interface IndependentSessionHost {
  deps: WorldlineDeps;
  acquireAdmission(): Promise<{ ok: true; lease: UncertainComparisonAdmissionLease } | { ok: false; error: string }>;
  liveCount(): number;
  construct(spec: {
    sourceRunId: null; sourceSessionFile?: string; sourceGitDir: string; baseStateId: string;
    model: string | null; thinkingLevel: string | null; expectedCandidates: 1;
    candidates: [{ label: "A"; role: "session" }]; admissionLease: UncertainComparisonAdmissionLease;
  }): Promise<ComparisonState>;
  buildTemplate(cmp: ComparisonState, store: SnapshotStore, state: string): Promise<void>;
  clone(cmp: ComparisonState): Promise<void>;
  support(cmp: ComparisonState): Promise<void>;
  resources(cmp: ComparisonState): Promise<void>;
  ensureLive(cmp: ComparisonState): void;
  forkSession(cmp: ComparisonState, source: string, destination: string): Promise<void>;
  start(cmp: ComparisonState, state: string): Promise<void>;
  teardown(id: string, error: string): Promise<void>;
}

export async function createIndependentSession(host: IndependentSessionHost, opts: IndependentSessionOptions): Promise<{
  ok: boolean; terminalId?: string; error?: string;
}> {
  const check = await host.deps.preflight();
  if (!check.ok) return { ok: false, error: check.reasons.join("; ") };
  const store = await host.deps.getStore();
  if (!store || store.sourceRoot !== host.deps.primaryRoot) return { ok: false, error: "the source repository is unavailable" };
  const admission = await host.acquireAdmission();
  if (!admission.ok) return admission;
  let cmp: ComparisonState | null = null;
  let requester: string | null = null;
  let workspaceId: string | null = null;
  try {
    if (host.liveCount() + 1 > 3) throw new Error("the live worldline budget is exhausted");
    const workspace = await host.deps.workspaceAt(host.deps.primaryRoot);
    if (!workspace) throw new Error("the source folder is no longer open");
    workspaceId = workspace.id;
    requester = `session:${randomUUID()}`;
    const lease = await host.deps.acquireWriteLease(workspaceId, requester, 5000);
    if (!lease.ok) throw new Error(lease.error ?? "the source workspace is busy");
    if (!(await host.deps.flushDirtyModels(requester, workspaceId)).ok) throw new Error("unsaved source changes could not be captured");
    const trustHashes = await host.deps.trustHashes();
    const state = await host.deps.capturePrimary();
    if (!state) throw new Error("the source snapshot is unavailable");
    cmp = await host.construct({
      sourceRunId: null, sourceGitDir: store.sourceGitDir, baseStateId: state,
      ...opts, expectedCandidates: 1, candidates: [{ label: "A", role: "session" }], admissionLease: admission.lease,
    });
    host.ensureLive(cmp);
    // The manifest distinguishes a user-owned session from disposable experiments.
    await host.buildTemplate(cmp, store, state);
    host.ensureLive(cmp);
    await host.clone(cmp);
    host.ensureLive(cmp);
    await host.support(cmp);
    host.ensureLive(cmp);
    const candidate = cmp.candidates.get("A")!;
    candidate.headStateId = state;
    candidate.sessionFile = coreSessionFile(candidate.sessionDir, "session");
    if (opts.sourceSessionFile && sessionBundleHasContent(opts.sourceSessionFile)) {
      await host.forkSession(cmp, opts.sourceSessionFile, candidate.sessionFile);
    }
    await host.resources(cmp);
    host.ensureLive(cmp);
    const source = await admitWorldlineForkSource(host.deps, trustHashes);
    if (!source.ok) throw new Error(source.error);
    host.ensureLive(cmp);
    host.deps.releaseWriteLease(workspaceId, requester);
    requester = null;
    await host.start(cmp, state);
    if (cmp.manifestWriteFailed) throw new Error("the new session could not be durably recorded");
    cmp.phase = "running";
    return { ok: true, terminalId: candidate.terminalId ?? undefined };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (cmp) await host.teardown(cmp.id, message);
    return { ok: false, error: message };
  } finally {
    if (requester && workspaceId) host.deps.releaseWriteLease(workspaceId, requester);
    admission.lease.release();
  }
}


/** Each project hydrates its own durable sessions after the one global orphan sweep. */
export async function loadIndependentSessions(root: BoundPromotionDirectory, primaryRoot: string): Promise<{
  sessions: Array<{ manifest: ComparisonManifest; binding: BoundPromotionDirectory }>; unproven: boolean;
}> {
  let unproven = false;
  const sessions: Array<{ manifest: ComparisonManifest; binding: BoundPromotionDirectory }> = [];
  let names: string[];
  try {
    names = await boundedWorldlineEntries({ path: root.path, limit: MAX_UNCERTAIN_COMPARISON_ROOT_ENTRIES,
      message: "too many retained work areas", workBudget: MAX_UNCERTAIN_SCAN_WORK_BYTES });
  } catch (error) {
    // Admission still refuses this exhausted root. Retain user data without
    // making the primary session unavailable during bounded recovery.
    console.warn(`[worldlines] saved sessions retained, recovery unavailable: ${String(error)}`);
    return { sessions, unproven: true };
  }
  for (const name of names) {
    // Only comparison directories are eligible; adjacent native ledgers are files.
    if (!/^cmp-[1-9][0-9]*$/.test(name)) continue;
    try {
      const binding = await openSavedDirectory(join(root.path, name), "saved session", root);
      await boundPromotionReadFile({ root: binding.path, rootIdentity: promotionIdentityOf(binding),
        components: [MARKER], parentIdentity: promotionIdentityOf(binding), maxBytes: 128 });
      const { manifest } = await readComparisonManifestBound(binding, undefined);
      if (manifest.id === name && manifest.session?.primaryRoot === primaryRoot) sessions.push({ manifest, binding });
    } catch { unproven = true; /* Unproven directories stay retained and cannot launch. */ }
  }
  return { sessions, unproven };
}

export async function restoreIndependentSession(cmp: ComparisonState, manifest: ComparisonManifest, binding: BoundPromotionDirectory, deps: WorldlineDeps): Promise<void> {
  const origin = manifest.session!;
  cmp.rootBinding = binding;
  cmp.rootIdentity = promotionIdentityOf(binding);
  const cand = cmp.candidates.get("A");
  if (!cand) return;
  cand.role = "session";
  if (manifest.status !== "complete") return;
  cand.sessionFile = coreSessionFile(cand.sessionDir, "session");
  try {
    const store = await deps.getStore();
    if (!store || store.sourceGitDir !== origin.sourceGitDir) throw new Error("the source repository changed");
    cmp.templateBinding = await openSavedDirectory(cmp.templateDir, "session template", binding);
    cmp.templateIdentity = promotionIdentityOf(cmp.templateBinding);
    cmp.profilesBinding = await openSavedDirectory(join(cmp.dir, "profiles"), "session profiles", binding);
    cmp.baseCommit = await gitHead(cmp.templateDir);
    cand.rootBinding = await openSavedDirectory(cand.dir, "session files", binding);
    cand.rootIdentity = promotionIdentityOf(cand.rootBinding);
    cand.supportBinding = await openSavedDirectory(cand.supportDir, "session support", binding);
    for (const [field, path] of [
      ["homeBinding", cand.homeDir], ["sessionBinding", cand.sessionDir], ["eventsBinding", cand.eventsDir],
      ["tmpBinding", cand.tmpDir], ["cacheBinding", cand.cacheDir],
    ] as const) cand[field] = await openSavedDirectory(path, "session support directory", cand.supportBinding);
    const profile = (await readPromotionEntry(cand.profilePath)).state;
    if (profile.type !== "missing") {
      if (profile.type !== "file") throw new Error("the saved sandbox profile is not a regular file");
      cand.profileLeaf = await boundPromotionExpectedLeaf(cand.profilePath, profile, "saved sandbox profile");
    }
    const controlPath = join(cand.eventsDir, "startup-control.json");
    const control = (await readPromotionEntry(controlPath)).state;
    if (control.type !== "missing") {
      if (control.type !== "file") throw new Error("the saved startup control is not a regular file");
      cand.controlLeaf = await boundPromotionExpectedLeaf(controlPath, control, "saved startup control");
    }
    cand.comparisonBaseStateId = cmp.baseStateId;
    cand.promotionBaseStateId = cmp.baseStateId;
    const head = await deps.captureHead(cand.dir, join(cand.dir, ".git"), cmp.baseStateId);
    cand.headStateId = head.commit;
    cand.pid = null;
    cand.lstart = null;
    cand.state = "settled";
    cand.error = null;
    cmp.phase = "running";
    cmp.error = null;
  } catch (error) { cmp.error = cand.error = `session recovery failed: ${String(error)}`; }
}

async function openSavedDirectory(path: string, field: string, parent: BoundPromotionDirectory): Promise<BoundPromotionDirectory> {
  const plan = await probePromotionDirectory(parent, path, field);
  if (!plan.identity) throw new Error(`${field} is missing; saved work was retained`);
  return { path: plan.path, dev: plan.identity.dev, ino: plan.identity.ino, capability: plan.identity.capability };
}
