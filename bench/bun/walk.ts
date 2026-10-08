// Directory-walk comparison on Windows: Bun FFI FindFirstFileExW vs node:fs (readdir+lstat) vs readdir recursive vs Bun.Glob
import { dlopen, FFIType } from "bun:ffi";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = process.argv[2] ?? "C:\\Windows\\System32";
const k32 = dlopen("kernel32.dll", {
  FindFirstFileExW: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.u64 },
  FindNextFileW: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
  FindClose: { args: [FFIType.u64], returns: FFIType.i32 },
});
const { FindFirstFileExW, FindNextFileW, FindClose } = k32.symbols;
const INVALID = 0xffffffffffffffffn;
const fd = new Uint8Array(592);
const fdv = new DataView(fd.buffer);
const fd16 = new Uint16Array(fd.buffer, 44, 260);

function ffiWalk(root: string) {
  let files = 0, dirs = 0, bytes = 0, calls = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    const h = FindFirstFileExW(Buffer.from(dir + "\\*\0", "utf16le"), 1 /*FindExInfoBasic*/, fd, 0, null, 2 /*LARGE_FETCH*/);
    calls++;
    if (h === INVALID) continue;
    do {
      calls++;
      let n = 0; while (fd16[n] !== 0) n++;
      if (n <= 2 && fd16[0] === 46 && (n === 1 || fd16[1] === 46)) continue;
      const name = String.fromCharCode.apply(null, fd16.subarray(0, n) as any);
      const attr = fdv.getUint32(0, true);
      if (attr & 0x10) { dirs++; if (!(attr & 0x400)) stack.push(dir + "\\" + name); }
      else { files++; bytes += fdv.getUint32(28, true) * 4294967296 + fdv.getUint32(32, true); }
    } while (FindNextFileW(h, fd));
    FindClose(h);
  }
  return { files, dirs, bytes, calls };
}

function nodeWalk(root: string) {
  let files = 0, dirs = 0, bytes = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let ents: fs.Dirent[];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = dir + "\\" + e.name;
      if (e.isDirectory()) { dirs++; stack.push(p); }
      else if (e.isSymbolicLink()) { files++; }
      else { files++; try { bytes += fs.lstatSync(p).size; } catch {} }
    }
  }
  return { files, dirs, bytes };
}

function recursiveNames(root: string) {
  try { return { entries: fs.readdirSync(root, { recursive: true }).length }; } catch (e: any) { return { err: e.code }; }
}

function globScan(root: string) {
  let n = 0;
  for (const _ of new Bun.Glob("**/*").scanSync({ cwd: root, onlyFiles: false, followSymlinks: false })) n++;
  return { entries: n };
}

console.log("Bun", Bun.version, "root", ROOT);
for (let rep = 0; rep < 2; rep++) {
  for (const [label, fn] of [["FFI FindFirstFileExW (names+sizes)", ffiWalk], ["node:fs readdir+lstat (names+sizes)", nodeWalk], ["fs.readdirSync recursive (names only)", recursiveNames], ["Bun.Glob scanSync (names only)", globScan]] as const) {
    const t = performance.now();
    let r: any;
    try { r = (fn as any)(ROOT); } catch (e: any) { r = { err: String(e.message).slice(0, 80) }; }
    console.log(`rep${rep} ${label}: ${(performance.now() - t).toFixed(0)} ms`, JSON.stringify(r));
  }
}
