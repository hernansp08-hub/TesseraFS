// Implementación en proceso del contrato (docs/ARQUITECTURA.md) sobre el almacén SoA.
import { ptr } from 'bun:ffi';
import { win32 as winPath } from 'node:path';
import { availableParallelism } from 'node:os';
import {
  encodeSlice, type ActionKind, type ActionResult, type ChildrenRequest, type ChildrenResponse, type ElevationInfo, type Engine,
  type ExtStat, type NodeRow, type ScanProgress, type ScanRequest, type ScanResult, type SearchRequest, type SearchResponse, type VolumeInfo,
} from '../../protocol/src/index.ts';
import { mftScan } from './mft.ts';
import { Store } from './store.ts';
import { walkScan } from './walk.ts';
import './walkworker.ts'; // registra el worker cuando este módulo se carga como tal
import { Mem, isElevated, kernel32, lastError, ole32, quietErrors, readW, shell32, winErrorText, wstr, wstr2 } from './win32.ts';

export interface EngineOptions {
  /** Workers para el recorrido; 0 = hilo principal. Por defecto: la mitad de los hilos (2..8). */
  threads?: number;
  workerUrl?: string | URL;
}

export class ScanBusyError extends Error { }

export const defaultThreads = () => Math.min(8, Math.max(2, Math.floor(availableParallelism() / 2)));

/** Normaliza una ruta de usuario: "c:" → "C:\", "C:/x/" → "C:\x". */
export function normalizePath(p: string): string {
  let s = (p || '').trim().replace(/\//g, '\\');
  if (/^[a-zA-Z]:$/.test(s)) s += '\\';
  if (!/^[a-zA-Z]:\\/.test(s) && !s.startsWith('\\\\')) throw new Error(`Ruta no válida (debe ser absoluta): ${p}`);
  s = winPath.normalize(s);
  if (/^[a-zA-Z]:\\$/.test(s)) return s[0].toUpperCase() + ':\\';
  s = s.replace(/\\+$/, '');
  if (/^[a-z]:/.test(s)) s = s[0].toUpperCase() + s.slice(1);
  return s;
}

function volumeRoot(path: string): string {
  if (/^[A-Za-z]:/.test(path)) return path.slice(0, 2).toUpperCase() + '\\';
  const m = path.match(/^\\\\[^\\]+\\[^\\]+/);
  return m ? m[0] + '\\' : path;
}

export function volumeInfo(root: string): VolumeInfo | null {
  const k = kernel32();
  const r = wstr(root);
  const label = new Uint16Array(261), fs = new Uint16Array(261), serial = new Uint32Array(1), maxc = new Uint32Array(1), fsf = new Uint32Array(1);
  if (!k.GetVolumeInformationW(r, label, 261, serial, maxc, fsf, fs, 261)) return null;
  const avail = new BigUint64Array(1), total = new BigUint64Array(1), free = new BigUint64Array(1);
  k.GetDiskFreeSpaceExW(r, avail, total, free);
  const spc = new Uint32Array(1), bps = new Uint32Array(1), nfc = new Uint32Array(1), tnc = new Uint32Array(1);
  const cl = k.GetDiskFreeSpaceW(r, spc, bps, nfc, tnc) ? spc[0] * bps[0] : 4096;
  return { path: root, label: readW(label), fs: readW(fs), total: Number(total[0]), free: Number(free[0]), clusterSize: cl };
}

export function volumes(): VolumeInfo[] {
  quietErrors();
  const k = kernel32();
  const mask = k.GetLogicalDrives(), out: VolumeInfo[] = [];
  for (let i = 0; i < 26; i++) {
    if (!(mask & (1 << i))) continue;
    const root = String.fromCharCode(65 + i) + ':\\';
    const type = k.GetDriveTypeW(wstr(root));
    if (type <= 1) continue; // desconocida o sin raíz
    const v = volumeInfo(root);
    if (v) out.push(v);
  }
  return out;
}

let comReady = false;
function ensureCom() {
  if (comReady) return;
  try { ole32().CoInitializeEx(null, 0x2 | 0x4 /* APARTMENTTHREADED | DISABLE_OLE1DDE */); } catch { /* sin COM: ShellExecuteEx suele funcionar igual */ }
  comReady = true;
}

/** SHELLEXECUTEINFOW (x64: 112 bytes). Devuelve 0 si fue bien o el código de error. */
export function shellExecuteEx(verb: string, file: string, params: string | null, dir: string | null, show: number, mask: number): number {
  ensureCom();
  const m = new Mem(112);
  const v = wstr(verb), f = wstr(file), p = params === null ? null : wstr(params), d = dir === null ? null : wstr(dir);
  m.dv.setUint32(0, 112, true);
  m.dv.setUint32(4, mask, true);
  m.setPtr(16, ptr(v)); m.setPtr(24, ptr(f)); m.setPtr(32, p ? ptr(p) : null); m.setPtr(40, d ? ptr(d) : null);
  m.dv.setInt32(48, show, true);
  const ok = shell32().ShellExecuteExW(m.p);
  const err = ok ? 0 : lastError();
  void [v, f, p, d]; // mantener vivos los búferes hasta aquí
  return err;
}

/** Relanza un programa con el verbo "runas" (UAC). 0 = lanzado; 1223 = cancelado por el usuario. */
export function runElevated(file: string, params: string, cwd: string, show = 0): number {
  return shellExecuteEx('runas', file, params, cwd, show, 0x00000400 /* SEE_MASK_FLAG_NO_UI */);
}

// Códigos heredados de SHFileOperation (no son errores Win32)
const DE_CODES: Record<number, string> = {
  0x71: 'Origen y destino son el mismo archivo', 0x75: 'Operación cancelada', 0x78: 'Acceso denegado',
  0x79: 'La ruta es demasiado larga', 0x7C: 'La ruta no es válida', 0x80: 'Ya existe un archivo con ese nombre',
  0x402: 'Error desconocido', 0x10000: 'Error en el destino',
};

function exists(path: string): boolean {
  const d = new Uint8Array(36);
  return kernel32().GetFileAttributesExW(wstr(path), 0, d) !== 0;
}

/** Envía a la papelera con SHFileOperationW (SHFILEOPSTRUCTW x64: 56 bytes). */
export function trashPath(path: string): ActionResult {
  const from = wstr2(path);
  const m = new Mem(56);
  m.dv.setUint32(8, 3, true); // FO_DELETE
  m.setPtr(16, ptr(from));
  // FOF_SILENT | FOF_NOCONFIRMATION | FOF_ALLOWUNDO | FOF_NOERRORUI | FOF_WANTNUKEWARNING
  // (la interfaz ya pidió confirmación; si no cabe en la papelera, Windows avisa antes de borrar)
  m.dv.setUint16(32, 0x4 | 0x10 | 0x40 | 0x400 | 0x4000, true);
  const rc = shell32().SHFileOperationW(m.p);
  void from;
  if (rc !== 0) return { ok: false, message: DE_CODES[rc] ?? winErrorText(rc) };
  if (m.dv.getInt32(36, true)) return { ok: false, message: 'Operación cancelada' };
  if (exists(path)) return { ok: false, message: 'Windows no movió el elemento a la papelera' };
  return { ok: true, message: 'Movido a la papelera' };
}

export class TesseraEngine {
  store: Store | null = null;
  result: ScanResult | null = null;
  scanning = false;
  readonly elevated = isElevated();
  private opts: EngineOptions;

  constructor(opts: EngineOptions = {}) { this.opts = opts; quietErrors(); }

  volumes(): VolumeInfo[] { return volumes(); }

  elevation(): ElevationInfo { return { elevated: this.elevated, canElevate: !this.elevated }; }

  async scan(req: ScanRequest, onProgress: (p: ScanProgress) => void = () => { }): Promise<ScanResult> {
    if (this.scanning) throw new ScanBusyError('Ya hay un escaneo en curso');
    this.scanning = true;
    // el árbol anterior se suelta ya: sus ids dejan de valer al terminar y así no conviven dos árboles en memoria
    this.store = null; this.result = null;
    Bun.gc(true);
    const t0 = performance.now();
    const ms = () => Math.round(performance.now() - t0);
    try {
      const path = normalizePath(req.path);
      onProgress({ phase: 'starting', entries: 0, bytes: 0, elapsedMs: 0, detail: path });
      const vol = volumeInfo(volumeRoot(path));
      const isNtfs = vol?.fs.toUpperCase() === 'NTFS';
      const isDriveRoot = /^[A-Z]:\\$/.test(path);
      const warnings: string[] = [];
      let engine: Engine = 'walk';
      let store: Store | null = null;
      let lastBytes = 0;
      const prog = (p: ScanProgress) => { lastBytes = p.bytes; onProgress(p); };

      const wantMft = req.engine === 'mft' || (req.engine === 'auto' && isDriveRoot);
      if (wantMft) {
        if (!this.elevated) warnings.push('MFT no disponible sin administrador: se usó el recorrido');
        else if (!isNtfs) warnings.push(`MFT no disponible en ${vol?.fs || 'este sistema de archivos'}: se usó el recorrido`);
        else if (!/^[A-Z]:\\/.test(path)) warnings.push('MFT no disponible en rutas de red: se usó el recorrido');
        else {
          try {
            const r = await mftScan(path, p => prog({ phase: p.phase, entries: p.entries, bytes: p.bytes, elapsedMs: ms(), detail: p.detail, fraction: p.fraction }));
            store = r.store; engine = 'mft'; warnings.push(...r.warnings);
          } catch (e) {
            warnings.push(`MFT no disponible (${(e as Error).message}): se usó el recorrido`);
          }
        }
      }
      if (!store) {
        const w = await walkScan(path, {
          threads: this.opts.threads ?? defaultThreads(), workerUrl: this.opts.workerUrl, trackKeys: isNtfs,
          onProgress: p => prog({ phase: 'walk', entries: p.entries, bytes: p.bytes, elapsedMs: ms(), detail: p.detail }),
        });
        store = w.store;
        if (w.denied) warnings.push(`${w.denied} carpetas sin permiso de lectura (acceso denegado); su contenido no se cuenta`);
        const other = w.errors.filter(e => !e.startsWith('Acceso denegado'));
        warnings.push(...w.errors.filter(e => e.startsWith('Acceso denegado')).slice(0, 20));
        warnings.push(...other.slice(0, 20));
        if (other.length > 20) warnings.push(`… y ${other.length - 20} errores más`);
        if (isNtfs) store.dedupHardlinks();
      }
      onProgress({ phase: 'aggregate', entries: store.n - 1, bytes: lastBytes, elapsedMs: ms(), detail: 'Calculando totales' });
      await new Promise(r => setImmediate(r));
      store.finalize();
      this.store = store;
      const root = store.rootId;
      const result: ScanResult = {
        rootId: root, rootPath: path, engine, entries: store.n - 1, files: store.nf[root], dirs: store.nd[root],
        bytes: store.sz[root], elapsedMs: ms(), volume: vol, warnings,
      };
      this.result = result;
      onProgress({ phase: 'done', entries: result.entries, bytes: result.bytes, elapsedMs: result.elapsedMs });
      Bun.gc(true); // devuelve al sistema la basura del escaneo (lotes, crecimiento de arreglos)
      return result;
    } catch (e) {
      onProgress({ phase: 'error', entries: 0, bytes: 0, elapsedMs: ms(), detail: (e as Error).message });
      throw e;
    } finally {
      this.scanning = false;
    }
  }

  private need(id: number): Store {
    const s = this.store;
    if (!s) throw new Error('Todavía no hay ningún escaneo');
    if (!s.has(id)) throw new Error(`Id de nodo no válido: ${id}`);
    return s;
  }

  slice(root: number, minBytes: number, maxNodes: number): Uint8Array {
    const s = this.need(root);
    return encodeSlice(s, root, Math.max(0, Number(minBytes) || 0), Math.max(1, Math.min(Number(maxNodes) || 1, 500000)));
  }

  children(r: ChildrenRequest): ChildrenResponse {
    const s = this.need(r.id);
    return s.childRows(r.id, r.offset, r.limit, r.sort, r.desc);
  }

  search(r: SearchRequest): SearchResponse {
    const s = this.need(r.root);
    return s.search(r.query ?? '', r.root, r.limit);
  }

  extStats(root: number): ExtStat[] { return this.need(root).extStats(root); }
  nodePath(id: number): string { return this.need(id).path(id); }
  nodeInfo(id: number): NodeRow { return this.need(id).row(id); }

  action(kind: ActionKind, id: number): ActionResult {
    const s = this.need(id);
    const path = s.path(id);
    switch (kind) {
      case 'open': {
        ensureCom();
        const r = Number(shell32().ShellExecuteW(0n, wstr('open'), wstr(path), null, null, 1));
        return r > 32 ? { ok: true } : { ok: false, message: winErrorText(r) };
      }
      case 'reveal': {
        ensureCom();
        const r = id === s.rootId
          ? Number(shell32().ShellExecuteW(0n, wstr('open'), wstr(path), null, null, 1))
          : Number(shell32().ShellExecuteW(0n, wstr('open'), wstr('explorer.exe'), wstr(`/select,"${path}"`), null, 1));
        return r > 32 ? { ok: true } : { ok: false, message: winErrorText(r) };
      }
      case 'properties': {
        const err = shellExecuteEx('properties', path, null, null, 5, 0x0000000C /* INVOKEIDLIST */ | 0x00000400 /* FLAG_NO_UI */);
        return err ? { ok: false, message: winErrorText(err) } : { ok: true };
      }
      case 'trash': {
        if (id === s.rootId) return { ok: false, message: 'No se puede enviar a la papelera la carpeta escaneada' };
        const r = trashPath(path);
        if (r.ok) s.remove(id);
        return r;
      }
      default:
        return { ok: false, message: `Acción desconocida: ${String(kind)}` };
    }
  }
}
