/** Deterministic provenance-bound cleanup probes for app-private directories. */
import { createHash } from 'node:crypto';
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bindOwnedDirectory,
  bindOwnedEntry,
  boundPromotionCreateDirectory,
  boundPromotionListEntries,
  boundPromotionOpenDirectory,
  boundPromotionReadFile,
  boundPromotionWriteFile,
  createOwnedDirectory,
  removeBoundOwnedDirectory,
  removeBoundOwnedEntry,
  writeBoundOwnedFile,
} from '../../electron/worldline-git.js';

type Identity = { dev: string; ino: string };

export default async function run(log: (message: string) => void) {
  const results: Array<{ name: string; ok: boolean; detail: string }> = [];
  const check = (name: string, ok: boolean, detail = '') => {
    results.push({ name, ok, detail });
    log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? ' — ' + detail : ''));
  };
  const work = mkdtempSync(join(tmpdir(), 'termina-owned-cleanup-'));
  const parent = join(work, 'parent');
  const outside = join(work, 'outside');
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  mkdirSync(outside, { recursive: true, mode: 0o700 });
  writeFileSync(join(outside, 'sentinel.txt'), 'outside\n');
  const identity = (path: string): Identity => {
    const info = lstatSync(path, { bigint: true });
    return { dev: String(info.dev), ino: String(info.ino) };
  };
  const hook = (name: string, stage = 'promotion-cleanup-root-open') => ({
    stage,
    readyPath: join(work, name + '-ready'),
    releasePath: join(work, name + '-release'),
  });
  const present = (path: string) => {
    try {
      lstatSync(path);
      return true;
    } catch {
      return false;
    }
  };
  const waitFor = async (path: string) => {
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      if (existsSync(path)) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('timed out waiting for ' + path);
  };

  const normal = join(parent, 'normal');
  mkdirSync(join(normal, 'nested'), { recursive: true, mode: 0o700 });
  writeFileSync(join(normal, 'nested', 'value.txt'), 'owned\n');
  const normalBinding = await bindOwnedDirectory(normal);
  await removeBoundOwnedDirectory({ binding: normalBinding });
  check('bound cleanup removes the original owned tree', !existsSync(normal));

  // A directory allocator must not create a child in a parked root after the
  // public root is replaced while the native request is waiting.  The native
  // descriptor remains useful for diagnostics, but the pathname provenance
  // check must reject before the mkdir/result boundary.
  const createRoot = join(parent, 'create-root');
  mkdirSync(createRoot, { mode: 0o700 });
  const createRootIdentity = await boundPromotionOpenDirectory({
    path: createRoot,
    expectedIdentity: identity(createRoot),
  });
  const createHook = hook('create-root-aba', 'promotion-directory-root-open');
  const createAttempt = createOwnedDirectory(
    createRoot,
    createRootIdentity,
    'owned-',
    createHook,
  ).then(
    () => ({ ok: true as const, error: '' }),
    (error) => ({ ok: false as const, error: String(error) }),
  );
  await waitFor(createHook.readyPath);
  const parkedCreateRoot = join(work, 'create-root-parked');
  renameSync(createRoot, parkedCreateRoot);
  mkdirSync(createRoot, { mode: 0o700 });
  writeFileSync(join(createRoot, 'replacement.txt'), 'replacement-root\n');
  writeFileSync(createHook.releasePath, 'release');
  const createResult = await createAttempt;
  check('directory create rejects a replaced root before mkdir/result', !createResult.ok && /identity|changed|root|ancestry/i.test(createResult.error), createResult.error);
  check('directory create preserves the replacement root', present(join(createRoot, 'replacement.txt')));
  check('directory create leaves no child in the parked root', !readdirSync(parkedCreateRoot).some((name) => name.startsWith('owned-')));
  rmSync(createRoot, { recursive: true, force: true });
  rmSync(parkedCreateRoot, { recursive: true, force: true });

  // The same create proof covers an ancestor replacement.  A symlink in the
  // absolute provenance chain is rejected by the native no-follow opener and
  // cannot redirect the operation to the outside directory.
  const createAncestor = join(work, 'create-ancestor');
  const createAncestorRoot = join(createAncestor, 'root');
  mkdirSync(createAncestorRoot, { recursive: true, mode: 0o700 });
  const createAncestorIdentity = await boundPromotionOpenDirectory({
    path: createAncestorRoot,
    expectedIdentity: identity(createAncestorRoot),
  });
  const createAncestorHook = hook('create-ancestor-aba', 'promotion-directory-root-open');
  const createAncestorAttempt = createOwnedDirectory(
    createAncestorRoot,
    createAncestorIdentity,
    'owned-',
    createAncestorHook,
  ).then(
    () => ({ ok: true as const, error: '' }),
    (error) => ({ ok: false as const, error: String(error) }),
  );
  await waitFor(createAncestorHook.readyPath);
  const parkedCreateAncestor = join(work, 'create-ancestor-parked');
  renameSync(createAncestor, parkedCreateAncestor);
  symlinkSync(outside, createAncestor, 'dir');
  writeFileSync(createAncestorHook.releasePath, 'release');
  const createAncestorResult = await createAncestorAttempt;
  check('directory create rejects an ancestor symlink replacement', !createAncestorResult.ok && /identity|changed|root|symbolic|component/i.test(createAncestorResult.error), createAncestorResult.error);
  check('directory create leaves the symlink target untouched', present(join(outside, 'sentinel.txt')));
  rmSync(createAncestor, { force: true });
  rmSync(parkedCreateAncestor, { recursive: true, force: true });

  // A require-missing create also has to reject a leaf that appears after the
  // parent was bound.  This is the first-create ABA at the mkdir syscall.
  const createLeafRoot = join(parent, 'create-leaf');
  mkdirSync(createLeafRoot, { mode: 0o700 });
  const createLeafIdentity = await boundPromotionOpenDirectory({
    path: createLeafRoot,
    expectedIdentity: identity(createLeafRoot),
  });
  const createLeafHook = hook('create-leaf-aba', 'promotion-directory-parent-open');
  const createLeafAttempt = boundPromotionCreateDirectory({
    root: createLeafRoot,
    rootIdentity: createLeafIdentity,
    components: ['new-directory'],
    parentIdentity: createLeafIdentity,
    requireMissing: true,
    testHook: createLeafHook,
  }).then(
    () => ({ ok: true as const, error: '' }),
    (error) => ({ ok: false as const, error: String(error) }),
  );
  await waitFor(createLeafHook.readyPath);
  mkdirSync(join(createLeafRoot, 'new-directory'), { mode: 0o700 });
  writeFileSync(join(createLeafRoot, 'new-directory', 'replacement.txt'), 'replacement-leaf\n');
  writeFileSync(createLeafHook.releasePath, 'release');
  const createLeafResult = await createLeafAttempt;
  check('directory create rejects a pre-created leaf', !createLeafResult.ok && /exists|identity|changed|directory/i.test(createLeafResult.error), createLeafResult.error);
  check('directory create preserves the pre-created leaf', present(join(createLeafRoot, 'new-directory', 'replacement.txt')));
  rmSync(createLeafRoot, { recursive: true, force: true });

  // Keep a paused native operation in flight while the JS event loop is
  // ticking.  This is a small responsiveness guard for startup/evidence
  // callers that now use the native owner asynchronously.
  const responsiveRoot = join(parent, 'responsive-root');
  mkdirSync(responsiveRoot, { mode: 0o700 });
  const responsiveIdentity = await boundPromotionOpenDirectory({
    path: responsiveRoot,
    expectedIdentity: identity(responsiveRoot),
  });
  const responsiveHook = hook('responsive-create', 'promotion-directory-root-open');
  let ticks = 0;
  const interval = setInterval(() => { ticks += 1; }, 1);
  const responsiveAttempt = createOwnedDirectory(responsiveRoot, responsiveIdentity, 'owned-', responsiveHook);
  await waitFor(responsiveHook.readyPath);
  await new Promise((resolve) => setTimeout(resolve, 25));
  const ticksBeforeRelease = ticks;
  writeFileSync(responsiveHook.releasePath, 'release');
  const responsive = await responsiveAttempt;
  clearInterval(interval);
  check('native owned create keeps the JS main loop responsive while waiting', ticksBeforeRelease > 0);
  check('responsive native owned create completes after release', !!responsive && present(responsive.path));
  await removeBoundOwnedDirectory({ binding: responsive });

  const promotionFileExpected = async (root: string, rootIdentity: Identity, name: string) => {
    const read = await boundPromotionReadFile({
      root,
      rootIdentity,
      components: [name],
      parentIdentity: rootIdentity,
    });
    const mode = lstatSync(join(root, name)).mode & 0o777;
    return {
      identity: read.identity,
      state: {
        type: 'file' as const,
        mode,
        size: String(read.content.byteLength),
        sha256: createHash('sha256').update(read.content).digest('hex'),
      },
    };
  };

  // Existing-file population must authenticate the leaf again immediately
  // before truncation.  Swapping in a symlink at the paused seam must leave
  // both the old file and the outside target intact.
  const populateSymlinkRoot = join(parent, 'populate-symlink');
  mkdirSync(populateSymlinkRoot, { mode: 0o700 });
  const populateSymlinkIdentity = await boundPromotionOpenDirectory({
    path: populateSymlinkRoot,
    expectedIdentity: identity(populateSymlinkRoot),
  });
  const populateSymlinkName = 'payload.txt';
  writeFileSync(join(populateSymlinkRoot, populateSymlinkName), 'old-payload\n', { mode: 0o600 });
  const populateSymlinkExpected = await promotionFileExpected(populateSymlinkRoot, populateSymlinkIdentity, populateSymlinkName);
  const populateSymlinkHook = hook('populate-symlink-aba', 'promotion-write-file-open');
  const populateSymlinkAttempt = boundPromotionWriteFile({
    root: populateSymlinkRoot,
    rootIdentity: populateSymlinkIdentity,
    components: [populateSymlinkName],
    parentIdentity: populateSymlinkIdentity,
    content: Buffer.from('new-payload\n'),
    expectedDestination: populateSymlinkExpected,
    testHook: populateSymlinkHook,
  }).then(
    () => ({ ok: true as const, error: '' }),
    (error) => ({ ok: false as const, error: String(error) }),
  );
  await waitFor(populateSymlinkHook.readyPath);
  const parkedPopulateSymlink = join(work, 'populate-symlink-parked.txt');
  renameSync(join(populateSymlinkRoot, populateSymlinkName), parkedPopulateSymlink);
  symlinkSync(outside, join(populateSymlinkRoot, populateSymlinkName), 'dir');
  writeFileSync(populateSymlinkHook.releasePath, 'release');
  const populateSymlinkResult = await populateSymlinkAttempt;
  check('file populate rejects a symlink leaf replacement before truncation', !populateSymlinkResult.ok && /changed|identity|write|evidence|symbolic/i.test(populateSymlinkResult.error), populateSymlinkResult.error);
  check('file populate preserves the parked original bytes', lstatSync(parkedPopulateSymlink).isFile() && String(readFileSync(parkedPopulateSymlink)) === 'old-payload\n');
  check('file populate preserves the symlink target', present(join(outside, 'sentinel.txt')));
  rmSync(join(populateSymlinkRoot, populateSymlinkName), { force: true });
  rmSync(parkedPopulateSymlink, { force: true });
  rmSync(populateSymlinkRoot, { recursive: true, force: true });

  // A hardlink replacement is the same namespace identity problem without a
  // symlink.  It must not cause the opened old descriptor to be truncated or
  // the replacement link to be consumed.
  const populateHardlinkRoot = join(parent, 'populate-hardlink');
  mkdirSync(populateHardlinkRoot, { mode: 0o700 });
  const populateHardlinkIdentity = await boundPromotionOpenDirectory({
    path: populateHardlinkRoot,
    expectedIdentity: identity(populateHardlinkRoot),
  });
  const populateHardlinkName = 'payload.txt';
  writeFileSync(join(populateHardlinkRoot, populateHardlinkName), 'old-hardlink\n', { mode: 0o600 });
  const populateHardlinkExpected = await promotionFileExpected(populateHardlinkRoot, populateHardlinkIdentity, populateHardlinkName);
  const populateHardlinkReplacement = join(work, 'populate-hardlink-replacement.txt');
  writeFileSync(populateHardlinkReplacement, 'replacement-hardlink\n');
  const populateHardlinkHook = hook('populate-hardlink-aba', 'promotion-write-file-open');
  const populateHardlinkAttempt = boundPromotionWriteFile({
    root: populateHardlinkRoot,
    rootIdentity: populateHardlinkIdentity,
    components: [populateHardlinkName],
    parentIdentity: populateHardlinkIdentity,
    content: Buffer.from('new-hardlink\n'),
    expectedDestination: populateHardlinkExpected,
    testHook: populateHardlinkHook,
  }).then(
    () => ({ ok: true as const, error: '' }),
    (error) => ({ ok: false as const, error: String(error) }),
  );
  await waitFor(populateHardlinkHook.readyPath);
  const parkedPopulateHardlink = join(work, 'populate-hardlink-parked.txt');
  renameSync(join(populateHardlinkRoot, populateHardlinkName), parkedPopulateHardlink);
  linkSync(populateHardlinkReplacement, join(populateHardlinkRoot, populateHardlinkName));
  writeFileSync(populateHardlinkHook.releasePath, 'release');
  const populateHardlinkResult = await populateHardlinkAttempt;
  check('file populate rejects a hardlink leaf replacement before truncation', !populateHardlinkResult.ok && /changed|identity|write|evidence/i.test(populateHardlinkResult.error), populateHardlinkResult.error);
  check('file populate preserves the hardlink replacement and bytes', present(populateHardlinkReplacement) && present(join(populateHardlinkRoot, populateHardlinkName)) && String(readFileSync(populateHardlinkReplacement)) === 'replacement-hardlink\n');
  check('file populate preserves the parked hardlink original', String(readFileSync(parkedPopulateHardlink)) === 'old-hardlink\n');
  rmSync(join(populateHardlinkRoot, populateHardlinkName), { force: true });
  rmSync(parkedPopulateHardlink, { force: true });
  rmSync(populateHardlinkReplacement, { force: true });
  rmSync(populateHardlinkRoot, { recursive: true, force: true });

  // Replacing an ancestor after the parent descriptor is opened must fail
  // before population.  The original file is retained below the parked
  // ancestor and the symlink target remains untouched.
  const populateAncestor = join(work, 'populate-ancestor');
  const populateAncestorRoot = join(populateAncestor, 'root');
  mkdirSync(populateAncestorRoot, { recursive: true, mode: 0o700 });
  const populateAncestorIdentity = await boundPromotionOpenDirectory({
    path: populateAncestorRoot,
    expectedIdentity: identity(populateAncestorRoot),
  });
  const populateAncestorName = 'payload.txt';
  writeFileSync(join(populateAncestorRoot, populateAncestorName), 'ancestor-old\n', { mode: 0o600 });
  const populateAncestorExpected = await promotionFileExpected(populateAncestorRoot, populateAncestorIdentity, populateAncestorName);
  const populateAncestorHook = hook('populate-ancestor-aba', 'promotion-write-parent-open');
  const populateAncestorAttempt = boundPromotionWriteFile({
    root: populateAncestorRoot,
    rootIdentity: populateAncestorIdentity,
    components: [populateAncestorName],
    parentIdentity: populateAncestorIdentity,
    content: Buffer.from('ancestor-new\n'),
    expectedDestination: populateAncestorExpected,
    testHook: populateAncestorHook,
  }).then(
    () => ({ ok: true as const, error: '' }),
    (error) => ({ ok: false as const, error: String(error) }),
  );
  await waitFor(populateAncestorHook.readyPath);
  const parkedPopulateAncestor = join(work, 'populate-ancestor-parked');
  renameSync(populateAncestor, parkedPopulateAncestor);
  symlinkSync(outside, populateAncestor, 'dir');
  writeFileSync(populateAncestorHook.releasePath, 'release');
  const populateAncestorResult = await populateAncestorAttempt;
  check('file populate rejects an ancestor symlink replacement', !populateAncestorResult.ok && /changed|identity|root|ancestry|symbolic/i.test(populateAncestorResult.error), populateAncestorResult.error);
  check('file populate preserves the parked ancestor bytes', String(readFileSync(join(parkedPopulateAncestor, 'root', populateAncestorName))) === 'ancestor-old\n');
  check('file populate leaves the ancestor symlink target intact', present(join(outside, 'sentinel.txt')));
  rmSync(populateAncestor, { force: true });
  rmSync(parkedPopulateAncestor, { recursive: true, force: true });

  // Missing-file population is also a first-create boundary.  A symlink
  // inserted after the parent proof must not be followed or replaced.
  const populateMissingRoot = join(parent, 'populate-missing');
  mkdirSync(populateMissingRoot, { mode: 0o700 });
  const populateMissingIdentity = await boundPromotionOpenDirectory({
    path: populateMissingRoot,
    expectedIdentity: identity(populateMissingRoot),
  });
  const populateMissingName = 'new.txt';
  const populateMissingHook = hook('populate-missing-aba', 'promotion-write-parent-open');
  const populateMissingAttempt = writeBoundOwnedFile({
    root: populateMissingRoot,
    rootIdentity: populateMissingIdentity,
    components: [populateMissingName],
    parentIdentity: populateMissingIdentity,
    content: Buffer.from('new-file\n'),
    testHook: populateMissingHook,
  }).then(
    () => ({ ok: true as const, error: '' }),
    (error) => ({ ok: false as const, error: String(error) }),
  );
  await waitFor(populateMissingHook.readyPath);
  symlinkSync(outside, join(populateMissingRoot, populateMissingName), 'dir');
  writeFileSync(populateMissingHook.releasePath, 'release');
  const populateMissingResult = await populateMissingAttempt;
  check('missing-file population rejects a symlink inserted before create', !populateMissingResult.ok && /exists|changed|identity|write|symbolic/i.test(populateMissingResult.error), populateMissingResult.error);
  check('missing-file population preserves the inserted symlink target', present(join(outside, 'sentinel.txt')));
  rmSync(join(populateMissingRoot, populateMissingName), { force: true });
  rmSync(populateMissingRoot, { recursive: true, force: true });

  const leaf = join(parent, 'leaf-aba');
  mkdirSync(leaf, { mode: 0o700 });
  writeFileSync(join(leaf, 'old.txt'), 'old\n');
  const leafBinding = await bindOwnedDirectory(leaf);
  const leafParked = join(work, 'leaf-aba-parked');
  const leafHook = hook('leaf-aba');
  const leafCleanup = removeBoundOwnedDirectory({ binding: leafBinding, testHook: leafHook }).then(
    () => ({ ok: true as const, error: '' }),
    (error) => ({ ok: false as const, error: String(error) }),
  );
  await waitFor(leafHook.readyPath);
  renameSync(leaf, leafParked);
  mkdirSync(leaf, { mode: 0o700 });
  writeFileSync(join(leaf, 'replacement.txt'), 'replacement\n');
  writeFileSync(leafHook.releasePath, 'release');
  const leafResult = await leafCleanup;
  check('leaf ABA cleanup fails closed', !leafResult.ok && /changed|identity|evidence/.test(leafResult.error), leafResult.error);
  check('leaf ABA preserves the replacement tree', existsSync(join(leaf, 'replacement.txt')));
  rmSync(leaf, { recursive: true, force: true });
  renameSync(leafParked, leaf);
  rmSync(leaf, { recursive: true, force: true });

  const ancestor = join(parent, 'ancestor');
  const ancestorLeaf = join(ancestor, 'owned');
  mkdirSync(ancestor, { mode: 0o700 });
  mkdirSync(ancestorLeaf, { mode: 0o700 });
  writeFileSync(join(ancestorLeaf, 'old.txt'), 'old\n');
  const ancestorBinding = await bindOwnedDirectory(ancestorLeaf);
  const ancestorParked = join(work, 'ancestor-parked');
  const ancestorLinkTarget = join(outside, 'ancestor-replacement');
  mkdirSync(ancestorLinkTarget, { mode: 0o700 });
  const ancestorHook = hook('ancestor-aba');
  const ancestorCleanup = removeBoundOwnedDirectory({ binding: ancestorBinding, testHook: ancestorHook }).then(
    () => ({ ok: true as const, error: '' }),
    (error) => ({ ok: false as const, error: String(error) }),
  );
  await waitFor(ancestorHook.readyPath);
  renameSync(ancestor, ancestorParked);
  symlinkSync(ancestorLinkTarget, ancestor, 'dir');
  writeFileSync(ancestorHook.releasePath, 'release');
  const ancestorResult = await ancestorCleanup;
  check('ancestor ABA cleanup fails closed', !ancestorResult.ok && /changed|identity|ancestry|evidence|not a directory|symbolic|levels/i.test(ancestorResult.error), ancestorResult.error);
  check('ancestor ABA preserves the outside replacement', existsSync(ancestorLinkTarget));
  rmSync(ancestor, { force: true });
  renameSync(ancestorParked, ancestor);
  rmSync(ancestor, { recursive: true, force: true });

  const symlinkLeaf = join(parent, 'symlink-leaf');
  mkdirSync(symlinkLeaf, { mode: 0o700 });
  const symlinkBinding = await bindOwnedDirectory(symlinkLeaf);
  const symlinkParked = join(work, 'symlink-leaf-parked');
  renameSync(symlinkLeaf, symlinkParked);
  symlinkSync(outside, symlinkLeaf, 'dir');
  let symlinkError = '';
  try {
    await removeBoundOwnedDirectory({ binding: symlinkBinding });
  } catch (error) {
    symlinkError = String(error);
  }
  check('symlink leaf cleanup fails closed', /changed|identity|directory|evidence|symbolic|levels/.test(symlinkError), symlinkError);
  check('symlink leaf cleanup leaves its target untouched', existsSync(join(outside, 'sentinel.txt')));
  rmSync(symlinkLeaf, { force: true });
  renameSync(symlinkParked, symlinkLeaf);
  rmSync(symlinkLeaf, { recursive: true, force: true });

  const hardlinkLeaf = join(parent, 'hardlink-leaf');
  mkdirSync(hardlinkLeaf, { mode: 0o700 });
  const hardlinkBinding = await bindOwnedDirectory(hardlinkLeaf);
  const hardlinkParked = join(work, 'hardlink-leaf-parked');
  const hardlinkReplacement = join(work, 'hardlink-replacement.txt');
  writeFileSync(hardlinkReplacement, 'hardlink replacement\n');
  renameSync(hardlinkLeaf, hardlinkParked);
  linkSync(hardlinkReplacement, hardlinkLeaf);
  let hardlinkError = '';
  try {
    await removeBoundOwnedDirectory({ binding: hardlinkBinding });
  } catch (error) {
    hardlinkError = String(error);
  }
  check('hardlink/type-flip cleanup fails closed', /changed|identity|directory|evidence/.test(hardlinkError), hardlinkError);
  check('hardlink replacement remains intact', existsSync(hardlinkReplacement) && existsSync(hardlinkLeaf));
  rmSync(hardlinkLeaf, { force: true });
  renameSync(hardlinkParked, hardlinkLeaf);
  rmSync(hardlinkLeaf, { recursive: true, force: true });

  // Leaf cleanup uses the same bound parent/identity transaction for regular
  // files and symlinks.  A genuine symlink leaf may be removed, but its
  // target must never be traversed.
  const linkRoot = join(parent, 'entry-links');
  mkdirSync(linkRoot, { mode: 0o700 });
  const linkRootIdentity = await boundPromotionOpenDirectory({
    path: linkRoot,
    expectedIdentity: identity(linkRoot),
  });
  const ownedLink = join(linkRoot, 'owned-link');
  symlinkSync(outside, ownedLink, 'dir');
  const ownedLinkBinding = await bindOwnedEntry(ownedLink, linkRootIdentity);
  await removeBoundOwnedEntry({ binding: ownedLinkBinding });
  check('bound cleanup removes a genuine symlink leaf without traversal', !present(ownedLink));
  check('genuine symlink cleanup preserves its target', present(join(outside, 'sentinel.txt')));
  rmSync(linkRoot, { recursive: true, force: true });

  // Startup cleanup records the leaf identity in the same native directory
  // scan as the name.  Replacing that leaf before the later remove must fail
  // closed instead of rebinding and deleting the replacement.
  const scannedRoot = join(parent, 'scanned-entry');
  mkdirSync(scannedRoot, { mode: 0o700 });
  const scannedRootIdentity = await boundPromotionOpenDirectory({
    path: scannedRoot,
    expectedIdentity: identity(scannedRoot),
  });
  const scannedName = 'startup-control.json';
  const scannedPath = join(scannedRoot, scannedName);
  writeFileSync(scannedPath, 'original-control\n');
  const scanned = (await boundPromotionListEntries({ root: scannedRoot, rootIdentity: scannedRootIdentity }))
    .find((entry) => entry.name === scannedName);
  if (!scanned) throw new Error('native cleanup scan did not return the original leaf');
  const scannedParked = join(work, 'scanned-entry-parked.txt');
  renameSync(scannedPath, scannedParked);
  writeFileSync(scannedPath, 'replacement-control\n');
  let scannedError = '';
  try {
    const binding = await bindOwnedEntry(scannedPath, scannedRootIdentity, scanned.identity);
    await removeBoundOwnedEntry({ binding });
  } catch (error) {
    scannedError = String(error);
  }
  check('native cleanup scan rejects a replaced leaf before deletion', /changed|identity|evidence/.test(scannedError), scannedError);
  check('native cleanup scan preserves the replacement leaf', present(scannedPath) && String(readFileSync(scannedPath)) === 'replacement-control\n');
  check('native cleanup scan preserves the original leaf', present(scannedParked) && String(readFileSync(scannedParked)) === 'original-control\n');
  rmSync(scannedRoot, { recursive: true, force: true });
  rmSync(scannedParked, { force: true });

  const entryRoot = join(parent, 'entry-aba');
  mkdirSync(entryRoot, { mode: 0o700 });
  const entryRootIdentity = await boundPromotionOpenDirectory({
    path: entryRoot,
    expectedIdentity: identity(entryRoot),
  });
  const entryName = 'owned.txt';
  const entryPath = join(entryRoot, entryName);
  writeFileSync(entryPath, 'entry-original\n');
  const entryBinding = await bindOwnedEntry(entryPath, entryRootIdentity);
  const parkedEntry = join(work, 'entry-aba-parked.txt');
  const entryHook = hook('entry-symlink-aba', 'promotion-cleanup-root-open');
  const entryAttempt = removeBoundOwnedEntry({ binding: entryBinding, testHook: entryHook }).then(
    () => ({ ok: true as const, error: '' }),
    (error) => ({ ok: false as const, error: String(error) }),
  );
  await waitFor(entryHook.readyPath);
  renameSync(entryPath, parkedEntry);
  symlinkSync(outside, entryPath, 'dir');
  writeFileSync(entryHook.releasePath, 'release');
  const entryResult = await entryAttempt;
  check('file cleanup rejects a symlink leaf replacement', !entryResult.ok && /changed|identity|cleanup|evidence|symbolic/i.test(entryResult.error), entryResult.error);
  check('file cleanup preserves its parked original', present(parkedEntry) && String(readFileSync(parkedEntry)) === 'entry-original\n');
  check('file cleanup preserves the symlink target', present(join(outside, 'sentinel.txt')));
  rmSync(entryPath, { force: true });
  rmSync(parkedEntry, { force: true });

  const hardEntryRoot = join(parent, 'entry-hardlink-aba');
  mkdirSync(hardEntryRoot, { mode: 0o700 });
  const hardEntryRootIdentity = await boundPromotionOpenDirectory({
    path: hardEntryRoot,
    expectedIdentity: identity(hardEntryRoot),
  });
  const hardEntryPath = join(hardEntryRoot, entryName);
  writeFileSync(hardEntryPath, 'entry-hard-original\n');
  const hardEntryBinding = await bindOwnedEntry(hardEntryPath, hardEntryRootIdentity);
  const parkedHardEntry = join(work, 'entry-hardlink-aba-parked.txt');
  const hardEntryReplacement = join(work, 'entry-hardlink-replacement.txt');
  writeFileSync(hardEntryReplacement, 'entry-hard-replacement\n');
  const hardEntryHook = hook('entry-hardlink-aba', 'promotion-cleanup-root-open');
  const hardEntryAttempt = removeBoundOwnedEntry({ binding: hardEntryBinding, testHook: hardEntryHook }).then(
    () => ({ ok: true as const, error: '' }),
    (error) => ({ ok: false as const, error: String(error) }),
  );
  await waitFor(hardEntryHook.readyPath);
  renameSync(hardEntryPath, parkedHardEntry);
  linkSync(hardEntryReplacement, hardEntryPath);
  writeFileSync(hardEntryHook.releasePath, 'release');
  const hardEntryResult = await hardEntryAttempt;
  check('file cleanup rejects a hardlink leaf replacement', !hardEntryResult.ok && /changed|identity|cleanup|evidence/i.test(hardEntryResult.error), hardEntryResult.error);
  check('file cleanup preserves the hardlink replacement and target', present(hardEntryPath) && present(hardEntryReplacement) && String(readFileSync(hardEntryReplacement)) === 'entry-hard-replacement\n');
  check('file cleanup preserves the parked hardlink original', present(parkedHardEntry) && String(readFileSync(parkedHardEntry)) === 'entry-hard-original\n');
  rmSync(hardEntryPath, { force: true });
  rmSync(parkedHardEntry, { force: true });
  rmSync(hardEntryReplacement, { force: true });
  rmSync(hardEntryRoot, { recursive: true, force: true });

  let staleCapabilityError = '';
  try {
    await boundPromotionOpenDirectory({ path: parent, expectedIdentity: identity(parent), capability: 'stale-owned-cleanup-capability' });
  } catch (error) {
    staleCapabilityError = String(error);
  }
  check('stale native capability propagates as an error', /capability|unknown|restart|identity/.test(staleCapabilityError), staleCapabilityError);

  rmSync(work, { recursive: true, force: true });
  const failed = results.filter((result) => !result.ok).length;
  log('\nowned-cleanup spike: ' + (results.length - failed) + '/' + results.length + ' passed');
  if (failed > 0) process.exitCode = 1;
}
