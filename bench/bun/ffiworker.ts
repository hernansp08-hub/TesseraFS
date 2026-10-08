import { Worker, isMainThread, parentPort } from "node:worker_threads";
import { dlopen, FFIType } from "bun:ffi";
const lib = () => dlopen("kernel32.dll", { GetCurrentThreadId: { args: [], returns: FFIType.u32 } }).symbols;
if (isMainThread) {
  console.log("main tid", lib().GetCurrentThreadId());
  const ws = Array.from({ length: 4 }, () => new Worker(new URL(import.meta.url)));
  const tids = await Promise.all(ws.map(w => new Promise(r => w.once("message", r))));
  console.log("worker tids via bun:ffi", tids);
  console.log("terminating..."); for (const w of ws) { const c = await w.terminate(); console.log("terminated", c); } console.log("all terminated");
} else {
  const f = lib(); let x = 0; const t = performance.now();
  for (let i = 0; i < 1e6; i++) x ^= f.GetCurrentThreadId();
  parentPort!.postMessage(`${f.GetCurrentThreadId()} (1e6 calls ${(performance.now() - t).toFixed(0)} ms)`);
}
