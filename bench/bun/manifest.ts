// Patch the RT_MANIFEST of a bun --compile exe using Win32 UpdateResourceW via bun:ffi, then check it still runs.
import { dlopen, FFIType } from "bun:ffi";
import * as fs from "node:fs";
const { symbols: k } = dlopen("kernel32.dll", {
  LoadLibraryExW: { args: [FFIType.ptr, FFIType.u64, FFIType.u32], returns: FFIType.u64 },
  FindResourceExW: { args: [FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u16], returns: FFIType.u64 },
  FreeLibrary: { args: [FFIType.u64], returns: FFIType.i32 },
  BeginUpdateResourceW: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.u64 },
  UpdateResourceW: { args: [FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u16, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  EndUpdateResourceW: { args: [FFIType.u64, FFIType.i32], returns: FFIType.i32 },
  GetLastError: { args: [], returns: FFIType.u32 },
});
const w = (s: string) => Buffer.from(s + "\0", "utf16le");
const [src, dst, level] = process.argv.slice(2);
fs.copyFileSync(src, dst);
const m = k.LoadLibraryExW(w(dst), 0n, 0x2 /*LOAD_LIBRARY_AS_DATAFILE*/);
let lang = -1;
for (const l of [0, 1033, 1024]) if (k.FindResourceExW(m, 24n, 1n, l) !== 0n) { lang = l; break; }
k.FreeLibrary(m);
console.log("existing RT_MANIFEST #1 language:", lang);
const xml = fs.readFileSync(src).toString("latin1");
const idx = xml.indexOf("requestedExecutionLevel"); const sx = xml.lastIndexOf("<?xml", idx), sa = xml.lastIndexOf("<assembly", idx); const s = (sx >= 0 && idx - sx < 4096) ? sx : sa; const e = xml.indexOf("</assembly>", idx) + "</assembly>".length; console.log("manifest bytes:", e - s);
let man = xml.slice(s, e).replace(/level="asInvoker"/, `level="${level}"`);
const data = Buffer.from(man, "utf8");
const h = k.BeginUpdateResourceW(w(dst), 0);
const ok1 = k.UpdateResourceW(h, 24n, 1n, lang < 0 ? 0 : lang, data, data.length);
const ok2 = k.EndUpdateResourceW(h, 0);
console.log("UpdateResourceW:", ok1, "EndUpdateResourceW:", ok2, "err", k.GetLastError());
const out = fs.readFileSync(dst);
const i = out.indexOf("requestedExecutionLevel level=");
console.log("patched manifest:", out.toString("latin1", i, i + 50), "size", out.length, "src size", fs.statSync(src).size);
