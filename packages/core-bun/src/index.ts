// @tessera/core-bun: motor de TesseraFS sobre Bun (bun:ffi).
export * from './engine.ts';
export * from './messages.ts';
export { Store, NONE, flagsFromAttrs } from './store.ts';
export { walkScan, setWalkWorkerUrl, DirReader, WALK_WORKER_FLAG } from './walk.ts';
export { mftScan } from './mft.ts';
export { findDuplicates, extendedPath, DUP_PREFIX, DUP_CHUNK, DUP_MAX_LIMIT, DUP_DEFAULT_LIMIT, DUP_HASH, type DupOptions } from './dup.ts';
export * as win32 from './win32.ts';
