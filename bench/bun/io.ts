// Sequential read throughput: node:fs readSync vs bun:ffi ReadFile (buffered and FILE_FLAG_NO_BUFFERING)
import { dlopen, FFIType, toArrayBuffer } from "bun:ffi";
import * as fs from "node:fs";
const FILE = process.argv[2];
const SIZE = 1024 * 1024 * 1024; // 1 GiB
const CH = 16 * 1024 * 1024;
const { symbols: k } = dlopen("kernel32.dll", {
  CreateFileW: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u64], returns: FFIType.u64 },
  ReadFile: { args: [FFIType.u64, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  SetFilePointerEx: { args: [FFIType.u64, FFIType.i64, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
  VirtualAlloc: { args: [FFIType.ptr, FFIType.u64, FFIType.u32, FFIType.u32], returns: FFIType.ptr },
  GetLastError: { args: [], returns: FFIType.u32 },
});
const w = (s: string) => Buffer.from(s + "\0", "utf16le");
if (!fs.existsSync(FILE) || fs.statSync(FILE).size !== SIZE) {
  const fd = fs.openSync(FILE, "w");
  const chunk = new Uint8Array(CH);
  for (let i = 0; i < chunk.length; i += 4096) chunk[i] = i & 255;
  for (let o = 0; o < SIZE; o += CH) fs.writeSync(fd, chunk);
  fs.closeSync(fd);
}
const mb = SIZE / 2 ** 20;
const report = (label: string, t: number, n: number) => console.log(`${label}: ${(performance.now() - t).toFixed(0)} ms, ${(n / 2 ** 20 / ((performance.now() - t) / 1000)).toFixed(0)} MiB/s`);

// node:fs readSync (OS cache)
{
  const buf = Buffer.allocUnsafe(CH);
  for (let rep = 0; rep < 2; rep++) {
    const fd = fs.openSync(FILE, "r"); let n = 0, r = 0; const t = performance.now();
    while ((r = fs.readSync(fd, buf, 0, CH, null)) > 0) n += r;
    report(`node:fs.readSync 16MiB chunks (cached) rep${rep}`, t, n); fs.closeSync(fd);
  }
}
// FFI ReadFile buffered (OS cache)
const vptr = k.VirtualAlloc(null, BigInt(CH), 0x3000, 0x04)!; // page-aligned
const view = new Uint8Array(toArrayBuffer(vptr, 0, CH));
const got = new Uint32Array(1);
for (const [label, flags] of [["FFI ReadFile buffered (cached)", 0x80], ["FFI ReadFile FILE_FLAG_NO_BUFFERING (from NVMe)", 0x20000000 | 0x08000000]] as const) {
  for (let rep = 0; rep < 2; rep++) {
    const h = k.CreateFileW(w(FILE), 0x80000000, 1, null, 3, flags, 0n);
    let n = 0; const t = performance.now();
    while (k.ReadFile(h, vptr, CH, got, null) && got[0] > 0) n += got[0];
    report(`${label} rep${rep}`, t, n); k.CloseHandle(h);
  }
}
console.log("checksum byte", view[4096]);
