/**
 * Filesystem reads for disk accounting, not application resource loading.
 * Electron's asar shim treats archives as virtual directories and ignores
 * bigint stats there. Retention scans must measure the physical file instead.
 */
import * as nodeFs from "node:fs";
import { createRequire } from "node:module";

// original-fs is an Electron builtin; ordinary Node already reads real disk.
const fsImpl: typeof nodeFs = process.versions.electron
  ? createRequire(import.meta.url)("original-fs")
  : nodeFs;

export const diskFs: typeof nodeFs.promises = fsImpl.promises;
export const diskFsSync: typeof nodeFs = fsImpl;
