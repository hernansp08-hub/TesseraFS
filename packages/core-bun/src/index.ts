// @tessera/core-bun: motor de TesseraFS sobre Bun (bun:ffi).
export * from './engine.ts';
export { Store, NONE, flagsFromAttrs } from './store.ts';
export { walkScan, setWalkWorkerUrl, DirReader, WALK_WORKER_FLAG } from './walk.ts';
export { mftScan } from './mft.ts';
export * as win32 from './win32.ts';
