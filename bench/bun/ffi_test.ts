import { dlopen, FFIType, ptr } from "bun:ffi";
import * as fs from "node:fs";

const k32 = dlopen("kernel32.dll", {
  GetCurrentProcessId: { args: [], returns: FFIType.u32 },
  GetLastError: { args: [], returns: FFIType.u32 },
  lstrlenW: { args: [FFIType.ptr], returns: FFIType.i32 },
  CreateFileW: {
    args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u64],
    returns: FFIType.u64,
  },
  CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
  DeviceIoControl: {
    args: [FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr],
    returns: FFIType.i32,
  },
  GetVolumeInformationW: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32],
    returns: FFIType.i32,
  },
});
const f = k32.symbols;
const w = (s: string) => Buffer.from(s + "\0", "utf16le");
const INVALID = 0xffffffffffffffffn;

console.log("Bun", Bun.version, process.platform, process.arch);

// 1. Call overhead
for (const round of [1, 2]) {
  const N = 10_000_000;
  let t = performance.now();
  let acc = 0;
  for (let i = 0; i < N; i++) acc ^= f.GetCurrentProcessId();
  let dt = performance.now() - t;
  console.log(`[r${round}] GetCurrentProcessId x${N}: ${dt.toFixed(0)} ms => ${((dt * 1e6) / N).toFixed(1)} ns/call`);
  const s = w("hello world");
  t = performance.now();
  for (let i = 0; i < N; i++) acc ^= f.lstrlenW(s);
  dt = performance.now() - t;
  console.log(`[r${round}] lstrlenW(Buffer) x${N}: ${dt.toFixed(0)} ms => ${((dt * 1e6) / N).toFixed(1)} ns/call`);
}

// 2. GetLastError reliability
const hBad = f.CreateFileW(w("C:\\definitely_nonexistent_xyz_123.txt"), 0x80000000, 3, null, 3, 0, 0n);
console.log("CreateFileW(nonexistent) =", hBad === INVALID ? "INVALID_HANDLE_VALUE" : hBad, "GetLastError =", f.GetLastError(), "(expect 2)");

// 3. GetVolumeInformationW
const fsName = new Uint16Array(64);
const serial = new Uint32Array(1), maxLen = new Uint32Array(1), flags = new Uint32Array(1);
const ok = f.GetVolumeInformationW(w("C:\\"), null, 0, serial, maxLen, flags, fsName, 64);
console.log("GetVolumeInformationW ok=", ok, "fs=", String.fromCharCode(...fsName.subarray(0, fsName.indexOf(0))));

// 4. Raw volume open via FFI: query-only (0 access) and GENERIC_READ
for (const [label, access] of [["0 (query)", 0], ["GENERIC_READ", 0x80000000]] as const) {
  const h = f.CreateFileW(w("\\\\.\\C:"), access, 3, null, 3, 0, 0n);
  const err = f.GetLastError();
  console.log(`CreateFileW(\\\\.\\C:, ${label}) ->`, h === INVALID ? `INVALID (err ${err})` : `handle 0x${h.toString(16)}`);
  if (h !== INVALID) {
    const out = new Uint8Array(128);
    const ret = new Uint32Array(1);
    const r = f.DeviceIoControl(h, 0x00090064 /*FSCTL_GET_NTFS_VOLUME_DATA*/, null, 0, out, out.length, ret, null);
    const e2 = f.GetLastError();
    if (r) {
      const dv = new DataView(out.buffer);
      console.log("  FSCTL_GET_NTFS_VOLUME_DATA ok; BytesPerFileRecordSegment =", dv.getUint32(44, true), "MftValidDataLength =", dv.getBigUint64(64, true));
    } else console.log("  FSCTL_GET_NTFS_VOLUME_DATA failed, err", e2);
    f.CloseHandle(h);
  }
}

// 5. node:fs on raw device path (no FFI)
for (const p of ["\\\\.\\C:", "\\\\?\\C:", "\\\\.\\PhysicalDrive0"]) {
  try {
    const fd = fs.openSync(p, "r");
    console.log(`fs.openSync(${p}) -> fd ${fd}`);
    fs.closeSync(fd);
  } catch (e: any) {
    console.log(`fs.openSync(${p}) -> ${e.code} ${e.message}`);
  }
}
