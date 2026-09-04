# Legacy and Backward-Compatibility Removal Plan

## Objective

Remove backward-compatible readers, migration flags, deprecated paths, and legacy protocol handling. End with one canonical implementation and one accepted durable format for each responsibility.

Existing durable user data must be migrated before strict readers replace compatibility code. Temporary migration logic is allowed only at the external disk boundary and must be deleted after the cutover.

## Canonical formats

The post-migration application accepts only:

1. **Sidecars:** writer-owned `.sealed` generations with `.owner` proof.
2. **Promotion journals:** current records containing `beforeState` and `afterState`.
3. **Promotion roots:** provenance-bound roots.
4. **Retained-session roots:** provenance-bound roots.
5. **Auth locks:** generation-bound transition names containing token, device, and inode.
6. **Pi bridge:** the app-owned bridge under Electron user data.

Durable formats must have an explicit current version. Runtime code must not parse multiple versions after migration.

## Phase 1 — Build a one-shot durable-state migrator

Run migration before the strict application starts. Each migration must either complete atomically or stop with an actionable error while preserving the original state. It must not partially adopt or silently reinterpret old state.

### 1.1 Promotion roots and retained sessions

Migrate existing unproven roots with the current native descriptor-bound validation and provenance transaction:

- worlds root,
- project primary roots,
- retained-session root.

Record completion using one application-format marker. New installations must create provenance when creating each root and must never enter migration.

After migration, remove:

- `PromotionRecoveryContext.bootstrapExistingWorldsRoot`,
- `PromotionRecoveryContext.bootstrapExistingPrimaryRoot`,
- `ensureBoundDirectory(...bootstrapExisting)`,
- unconditional legacy adoption in `ensureBoundRetainedRoot()`,
- `boundPromotionEnsureDirectory.bootstrapExisting`,
- Rust `bootstrapExisting` request handling,
- Rust legacy retained-tree adoption and validation branches,
- tests and protocol types dedicated to those options.

### 1.2 Promotion journals

Before installing the strict journal parser:

1. Enumerate pending promotion journals.
2. Recover legacy journals with the current implementation.
3. Require the journal directory to be empty afterward.
4. If recovery cannot prove safety, retain the journal as evidence and abort migration.

Then remove acceptance of the five-field legacy journal record in `electron/worldlines.ts`. The strict parser must require `beforeState` and `afterState`, plus current retained/before-image metadata where applicable. It must not derive missing state from hashes or `beforeExists`.

### 1.3 Project-local bridge

During migration:

1. Search known projects for `.pi/extensions/termina-bridge.ts`.
2. Delete it only when the generated marker proves application ownership.
3. Report ambiguous files without modifying them.

Afterward remove `removeLegacyProjectBridge()`, its project-open call, and related tests/comments. Ordinary project activation must not inspect or modify `.pi/extensions`.

### 1.4 Auth-lock transitions

While no old agent-core process is running:

1. Inspect old `.released-<32hex>` and `.recovered-<32hex>` entries.
2. Recover or quarantine them using the existing ownership checks.
3. Require no old transition entries before launching the new core.

Then remove the legacy regex branch from `parseAuthLockTransitionEntry()`. The strict runtime must accept only generation-bound transition entries.

## Phase 2 — Cut over the sidecar protocol

Sidecars are temporary runtime state. Do not retain a long-lived migration parser for them.

### 2.1 Namespace cutover

1. Stop and await every Termina-owned Pi and agent-core producer during upgrade or shutdown.
2. Introduce a new default event namespace, such as `termina-events-v2`.
3. Launch both canonical writers with the new directory:
   - the generated Pi bridge,
   - `agent-core/main.ts`.
4. Tail only the new namespace.
5. Leave the previous directory untouched until no producer can still have it open, then remove it through scoped cleanup.

`TERMINA_EVENTS_DIR` remains configurable, but a configured directory must contain only the current protocol.

### 2.2 Remove writer compatibility

From `electron/bridge-extension.ts` and `agent-core/main.ts`, remove:

- `hasLegacyAdmissionOverflow()`,
- `.segment.legacy-*` scanning,
- legacy anchor limits,
- legacy-specific quarantine reasons,
- branches that exist only to protect concurrent legacy replacement.

Retain canonical `.sealed`, `.owner`, backpressure, retained/draining/final handling where required for current-protocol crash recovery.

### 2.3 Remove tailer compatibility

From `electron/sidecar.ts`, remove:

- `.segment` support,
- `.legacy-*` anchors,
- `LegacySegmentSource`,
- `legacySources`,
- `legacySegmentsDrained`,
- `legacySourceOverflow`,
- `SegmentCandidate.legacy`,
- compatibility-hazard branches,
- sequence-gap behavior specific to unproven legacy sources.

Simplify the durable cursor by removing legacy fields:

- `segmentOffset`,
- `segmentIdentity`,
- `segmentSources`.

Keep only state required for active and canonical sealed generations. A cursor that does not match the current schema is stale temporary state and must not be parsed through a fallback schema.

## Phase 3 — Remove stale internal paths

After durable migration and sidecar cutover:

1. Delete any unused unbound session-discard operation and its worker/core protocol operation. The production path must use only native bound cleanup.
2. Remove obsolete IPC fields, request options, decoders, aliases, types, fixtures, tests, and documentation together with each removed path.
3. Rename comments such as “legacy mkdir-p behavior” when they describe required current semantics rather than compatibility.
4. Review the cache “legacy fallback” referenced near `agent-core/main.ts:7020`. Make one policy canonical and delete the fallback rather than passing a sentinel solely to disable it.
5. Search the repository for `legacy`, `compat`, `deprecated`, `bootstrapExisting`, old schema fields, and old protocol suffixes. Classify every remaining occurrence; remove all compatibility behavior.

## Phase 4 — Enforcement tests

Add negative tests proving removed formats cannot return:

1. `.segment` sidecars are ignored or rejected.
2. `.legacy-*` anchors are never created.
3. Old sidecar cursor fields fail strict decoding.
4. Five-field promotion journal records fail validation.
5. Unproven existing worlds and retained roots fail to bind in normal runtime.
6. `bootstrapExisting` is rejected as an unknown core request field.
7. Old auth transition filenames are not interpreted as ownership evidence.
8. Project activation does not inspect or modify `.pi/extensions`.
9. Repository checks find no production compatibility branches or deprecated aliases.

Keep positive crash-recovery and race tests for the canonical formats.

## Commit sequence

1. Define canonical format versions and strict-format tests.
2. Add the one-shot durable-state migrator.
3. Migrate promotion roots, retained sessions, journals, auth locks, and project bridges.
4. Add a release gate proving durable migration completed.
5. Delete promotion, journal, auth-lock, and bridge compatibility code.
6. Cut sidecars over to the new namespace.
7. Delete sidecar writer and tailer compatibility code.
8. Remove dead protocol fields, types, tests, fixtures, and docs.
9. Run the final repository-wide compatibility audit.

Do not combine migration and compatibility deletion in one unverified change. Each deletion commit must prove all callers and persisted state have already moved to the canonical format.

## Verification

Run after every phase:

```sh
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/vitest run
cargo test --manifest-path core/Cargo.toml
pnpm run test:e2e
```

Final release gates:

- no pending or unreadable promotion journals,
- every durable root has valid provenance,
- no old auth-lock transition entries,
- no running producer uses the previous sidecar namespace,
- no project-open path contains legacy bridge cleanup,
- no production parser accepts an old schema,
- no compatibility flag remains in IPC or core protocol types.
