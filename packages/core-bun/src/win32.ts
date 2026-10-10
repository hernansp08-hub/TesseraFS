// Enlaces bun:ffi a la API de Windows. Los HANDLE viajan como u64 (bigint o number).
// Las bibliotecas se cargan bajo demanda: los workers sólo necesitan kernel32 y ntdll.
import { dlopen, FFIType as T, ptr, read, toArrayBuffer, type Pointer } from 'bun:ffi';

const { u8, u32, i32, u64, i64, ptr: P } = T;

function lazy<F>(load: () => F): () => F {
  let v: F | undefined;
  return () => (v ??= load());
}

export const kernel32 = lazy(() => dlopen('kernel32.dll', {
  CreateFileW: { args: [P, u32, u32, P, u32, u32, u64], returns: u64 },
  CloseHandle: { args: [u64], returns: i32 },
  DeviceIoControl: { args: [u64, u32, P, u32, P, u32, P, P], returns: i32 },
  ReadFile: { args: [u64, P, u32, P, P], returns: i32 },
  SetFilePointerEx: { args: [u64, i64, P, u32], returns: i32 },
  GetLastError: { args: [], returns: u32 },
  GetLogicalDrives: { args: [], returns: u32 },
  GetDriveTypeW: { args: [P], returns: u32 },
  GetVolumeInformationW: { args: [P, P, u32, P, P, P, P, u32], returns: i32 },
  GetDiskFreeSpaceExW: { args: [P, P, P, P], returns: i32 },
  GetDiskFreeSpaceW: { args: [P, P, P, P, P], returns: i32 },
  GetFileAttributesExW: { args: [P, i32, P], returns: i32 },
  GetFullPathNameW: { args: [P, u32, P, P], returns: u32 },
  VirtualAlloc: { args: [P, u64, u32, u32], returns: P },
  VirtualFree: { args: [P, u64, u32], returns: i32 },
  GetConsoleWindow: { args: [], returns: u64 },
  GetConsoleProcessList: { args: [P, u32], returns: u32 },
  GetCurrentProcess: { args: [], returns: u64 },
  SetErrorMode: { args: [u32], returns: u32 },
  FormatMessageW: { args: [u32, P, u32, u32, P, u32, P], returns: u32 },
  FindFirstFileExW: { args: [P, i32, P, i32, P, u32], returns: u64 },
  FindNextFileW: { args: [u64, P], returns: i32 },
  FindClose: { args: [u64], returns: i32 },
}).symbols);

export const ntdll = lazy(() => dlopen('ntdll.dll', {
  NtOpenFile: { args: [P, u32, P, P, u32, u32], returns: i32 },
  NtQueryDirectoryFile: { args: [u64, u64, P, P, P, P, u32, i32, u8, P, u8], returns: i32 },
  NtClose: { args: [u64], returns: i32 },
  RtlNtStatusToDosError: { args: [u32], returns: u32 },
}).symbols);

export const shell32 = lazy(() => dlopen('shell32.dll', {
  ShellExecuteW: { args: [u64, P, P, P, P, i32], returns: u64 },
  ShellExecuteExW: { args: [P], returns: i32 },
  SHFileOperationW: { args: [P], returns: i32 },
  IsUserAnAdmin: { args: [], returns: i32 },
  SHGetKnownFolderPath: { args: [P, u32, u64, P], returns: i32 },
}).symbols);

export const user32 = lazy(() => dlopen('user32.dll', {
  ShowWindow: { args: [u64, i32], returns: i32 },
  FindWindowW: { args: [P, P], returns: u64 },
  PostMessageW: { args: [u64, u32, u64, i64], returns: i32 },
  GetClassNameW: { args: [u64, P, i32], returns: i32 },
  FindWindowExW: { args: [u64, u64, P, P], returns: u64 },
  GetWindowThreadProcessId: { args: [u64, P], returns: u32 },
  IsWindowVisible: { args: [u64], returns: i32 },
}).symbols);

export const advapi32 = lazy(() => dlopen('advapi32.dll', {
  OpenProcessToken: { args: [u64, u32, P], returns: i32 },
  GetTokenInformation: { args: [u64, u32, P, u32, P], returns: i32 },
  RegGetValueW: { args: [u64, P, P, u32, P, P, P], returns: i32 },
}).symbols);

export const ole32 = lazy(() => dlopen('ole32.dll', {
  CoInitializeEx: { args: [P, u32], returns: i32 },
  CoTaskMemFree: { args: [P], returns: T.void },
}).symbols);

// ---------- constantes ----------
export const INVALID_HANDLE = 0xFFFFFFFFFFFFFFFFn;
export const GENERIC_READ = 0x80000000;
export const FILE_SHARE_ALL = 0x7; // READ | WRITE | DELETE
export const OPEN_EXISTING = 3;
export const FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
export const FILE_FLAG_NO_BUFFERING = 0x20000000;
export const FILE_FLAG_SEQUENTIAL_SCAN = 0x08000000;

export const ATTR = {
  READONLY: 0x1, HIDDEN: 0x2, SYSTEM: 0x4, DIRECTORY: 0x10, ARCHIVE: 0x20, SPARSE: 0x200, REPARSE: 0x400,
  COMPRESSED: 0x800, OFFLINE: 0x1000, RECALL_ON_OPEN: 0x40000, RECALL_ON_DATA_ACCESS: 0x400000,
} as const;

export const REPARSE_TAG_WOF = 0x80000017;
/** Las etiquetas "name surrogate" (bit 29) son enlaces: junctions, symlinks, puntos de montaje. */
export const isNameSurrogate = (tag: number) => (tag & 0x20000000) !== 0;
/** Marcadores de OneDrive/Files On-Demand: IO_REPARSE_TAG_CLOUD_x = 0x9000?01A */
export const isCloudTag = (tag: number) => ((tag >>> 0) & 0xFFFF0FFF) === 0x9000001A;

export const STATUS = {
  SUCCESS: 0, BUFFER_OVERFLOW: 0x80000005, NO_MORE_FILES: 0x80000006, INVALID_INFO_CLASS: 0xC0000003,
  INVALID_PARAMETER: 0xC000000D, ACCESS_DENIED: 0xC0000022, NOT_SUPPORTED: 0xC00000BB,
  OBJECT_NAME_NOT_FOUND: 0xC0000034, OBJECT_PATH_NOT_FOUND: 0xC000003A,
} as const;

// ---------- cadenas UTF-16 ----------
/** Cadena terminada en cero lista para pasar como LPCWSTR. */
export function wstr(s: string): Buffer {
  return Buffer.from(s + '\0', 'utf16le');
}
/** Cadena doblemente terminada en cero (SHFileOperationW.pFrom). */
export function wstr2(s: string): Buffer {
  return Buffer.from(s + '\0\0', 'utf16le');
}
/** Lee UTF-16 de un Uint16Array hasta `len` unidades o hasta el primer cero. */
export function readW(u16: Uint16Array, start = 0, len = -1): string {
  let end = start;
  if (len < 0) { while (end < u16.length && u16[end] !== 0) end++; } else end = start + len;
  let s = '';
  for (let i = start; i < end; i += 4096) s += String.fromCharCode.apply(null, u16.subarray(i, Math.min(end, i + 4096)) as unknown as number[]);
  return s;
}

/** Bloque de memoria fija para estructuras (no lo mueve el GC mientras viva). */
export class Mem {
  readonly u8: Uint8Array;
  readonly dv: DataView;
  readonly p: Pointer;
  constructor(size: number) {
    this.u8 = new Uint8Array(new ArrayBuffer(Math.max(8, size)));
    this.dv = new DataView(this.u8.buffer);
    this.p = ptr(this.u8);
  }
  setPtr(off: number, p: Pointer | number | null) { this.dv.setBigUint64(off, BigInt(p ?? 0), true); }
}

/** Memoria alineada a página con VirtualAlloc (necesaria para lecturas sin caché). */
export function alignedAlloc(size: number): { p: Pointer; u8: Uint8Array; free(): void } {
  const k = kernel32();
  const p = k.VirtualAlloc(null, BigInt(size), 0x3000 /* COMMIT|RESERVE */, 0x04 /* READWRITE */);
  if (!p) throw new Error('VirtualAlloc failed');
  return { p, u8: new Uint8Array(toArrayBuffer(p, 0, size)), free: () => { k.VirtualFree(p, 0n, 0x8000 /* RELEASE */); } };
}

export function lastError(): number { return kernel32().GetLastError(); }

/** Texto de un código de error Win32 (en el idioma del sistema). */
export function winErrorText(code: number): string {
  const buf = new Uint16Array(512);
  const n = kernel32().FormatMessageW(0x1000 | 0x200 /* FROM_SYSTEM | IGNORE_INSERTS */, null, code >>> 0, 0, buf, buf.length, null);
  const msg = n ? readW(buf, 0, n).trim() : '';
  return msg ? `${msg} (${code})` : `Error ${code}`;
}

export function ntStatusText(status: number): string {
  const code = ntdll().RtlNtStatusToDosError(status >>> 0);
  return winErrorText(code);
}

/** FILETIME (100 ns desde 1601) en dos u32 → segundos Unix (u32, 0 si no hay). */
export function filetimeToUnix(lo: number, hi: number): number {
  const s = Math.floor((hi * 4294967296 + lo) / 1e7) - 11644473600;
  return s > 0 ? Math.min(s, 0xFFFFFFFF) : 0;
}

// ---------- utilidades de proceso ----------
export function isElevated(): boolean {
  try {
    const a = advapi32(), h = new BigUint64Array(1);
    if (a.OpenProcessToken(kernel32().GetCurrentProcess(), 0x8 /* TOKEN_QUERY */, h)) {
      const out = new Uint32Array(1), ret = new Uint32Array(1);
      const ok = a.GetTokenInformation(h[0], 20 /* TokenElevation */, out, 4, ret);
      kernel32().CloseHandle(h[0]);
      if (ok) return out[0] !== 0;
    }
  } catch { /* se intenta abajo */ }
  try { return shell32().IsUserAnAdmin() !== 0; } catch { return false; }
}

/** Evita los diálogos "inserte un disco" al consultar unidades vacías. */
export function quietErrors() {
  try { kernel32().SetErrorMode(0x0001 | 0x8000 /* FAILCRITICALERRORS | NOOPENFILEERRORBOX */); } catch { /* sin efecto */ }
}

export function hideConsole(): boolean {
  try {
    const hwnd = kernel32().GetConsoleWindow();
    if (!hwnd) return false;
    user32().ShowWindow(hwnd, 0 /* SW_HIDE */);
    return true;
  } catch { return false; }
}

/**
 * Estado de la consola del proceso: "none" (sin consola), "shared" (la comparte con otro proceso,
 * p. ej. se lanzó desde un cmd abierto), "conhost" (ventana clásica propia) u "other" (Windows Terminal…).
 */
export function consoleKind(): 'none' | 'shared' | 'conhost' | 'other' {
  try {
    const k = kernel32(), hwnd = k.GetConsoleWindow();
    if (!hwnd) return 'none';
    const list = new Uint32Array(8);
    if (k.GetConsoleProcessList(list, 8) > 1) return 'shared';
    const cls = new Uint16Array(64);
    const n = user32().GetClassNameW(hwnd, cls, 64);
    return readW(cls, 0, n) === 'ConsoleWindowClass' ? 'conhost' : 'other';
  } catch { return 'none'; }
}

/** ¿Tiene el proceso alguna ventana de nivel superior visible de la clase dada? */
export function hasVisibleWindow(pid: number, cls = 'Chrome_WidgetWin_1'): boolean {
  const u = user32(), c = wstr(cls), out = new Uint32Array(1);
  let h: bigint | number = 0n;
  for (let i = 0; i < 5000; i++) {
    h = u.FindWindowExW(0n, h, c, null);
    if (!h) return false;
    u.GetWindowThreadProcessId(h, out);
    if (out[0] === pid && u.IsWindowVisible(h)) return true;
  }
  return false;
}

// ---------- carpetas conocidas ----------
export const FOLDERID = {
  Downloads: '{374DE290-123F-4565-9164-39C4925E467B}',
  LocalAppData: '{F1B32785-6FBA-4FCF-9D55-7B8E7F157091}',
} as const;

/** GUID en texto → los 16 bytes de la estructura GUID (Data1..3 little-endian, Data4 tal cual). */
export function guidBytes(g: string): Uint8Array {
  const h = g.replace(/[{}-]/g, '');
  const b = new Uint8Array(16), dv = new DataView(b.buffer);
  dv.setUint32(0, parseInt(h.slice(0, 8), 16), true);
  dv.setUint16(4, parseInt(h.slice(8, 12), 16), true);
  dv.setUint16(6, parseInt(h.slice(12, 16), 16), true);
  for (let i = 0; i < 8; i++) b[8 + i] = parseInt(h.slice(16 + 2 * i, 18 + 2 * i), 16);
  return b;
}

/** Ruta de una carpeta conocida (SHGetKnownFolderPath, p. ej. FOLDERID.Downloads); null si falla. */
export function knownFolder(id: string): string | null {
  try {
    const out = new BigUint64Array(1);
    const hr = shell32().SHGetKnownFolderPath(guidBytes(id), 0, 0n, out);
    const p = Number(out[0]) as Pointer;
    try {
      if (hr !== 0 || !p) return null;
      let s = '';
      for (let off = 0; off < 0x10000; off += 2) {
        const c = read.u16(p, off);
        if (!c) break;
        s += String.fromCharCode(c);
      }
      return s || null;
    } finally {
      if (p) ole32().CoTaskMemFree(p); // se libera también si falló
    }
  } catch { return null; }
}

/** Valor REG_SZ del registro; null si no existe. */
export function regString(root: 'HKLM' | 'HKCU', subkey: string, value: string | null): string | null {
  const hkey = root === 'HKLM' ? 0xFFFFFFFF80000002n : 0xFFFFFFFF80000001n;
  const buf = new Uint16Array(2048), cb = new Uint32Array([buf.byteLength]);
  const rc = advapi32().RegGetValueW(hkey, wstr(subkey), value === null ? null : wstr(value), 0x2 /* RRF_RT_REG_SZ (expande REG_EXPAND_SZ) */, null, buf, cb);
  return rc === 0 ? readW(buf) : null;
}
