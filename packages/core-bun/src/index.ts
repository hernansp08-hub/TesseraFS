// @tessera/core-bun: motor de TesseraFS sobre Bun (bun:ffi).
export * from './engine.ts';
export * from './messages.ts';
export { Store, NONE, DEAD, flagsFromAttrs, CMP_MATCHED, CMP_FRESH, type CompareState } from './store.ts';
export {
  historyDir, exportDir, fnv1a32, pathHash, historyId, buildSnapshot, parseSnapshot, listHistory, saveHistory, deleteHistory,
  clearHistory, compareHistory, compareSnapshot, validExportName, exportFile, exportedFile,
  HISTORY_KEEP, SNAP_MIN_FILE, COMPARE_MAX_LIMIT, COMPARE_DEFAULT_LIMIT, EXPORT_MAX_NAME,
  type Snapshot, type SnapNode, type LoadedSnapshot,
} from './history.ts';
export { walkScan, setWalkWorkerUrl, DirReader, WALK_WORKER_FLAG } from './walk.ts';
export { mftScan } from './mft.ts';
export { freeUp, freeUpAttrs, freeUpCandidates, win32AttrIo, FREE_UP_SETTABLE, type AttrIo } from './cloud.ts';
export { findDuplicates, extendedPath, DUP_PREFIX, DUP_CHUNK, DUP_MAX_LIMIT, DUP_DEFAULT_LIMIT, DUP_HASH, type DupOptions } from './dup.ts';
export * as win32 from './win32.ts';
