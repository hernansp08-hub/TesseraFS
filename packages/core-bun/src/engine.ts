// Implementación en proceso del contrato (docs/ARQUITECTURA.md) sobre el almacén SoA.
import { ptr } from 'bun:ffi';
import { win32 as winPath } from 'node:path';
import { availableParallelism } from 'node:os';
import {
  FLAG, encodeSlice, type ActionKind, type ActionResult, type ChildrenRequest, type ChildrenResponse, type CompareResult, type DupProgress,
  type DupRequest, type DupResult, type ElevationInfo, type Engine,
  type EngineMessage, type ExportResult, type ExtStat, type HistoryEntry, type NodeRow, type RefreshResult, type RescanResult,
  type SavedScanInfo, type ScanProgress, type ScanRequest, type ScanResult, type SearchRequest, type SearchResponse, type TrendPoint,
  type VolumeInfo,
} from '../../protocol/src/index.ts';
import { EngineError, engineError, errorText, msg, type MessageCode, type MessageParams } from './messages.ts';
import { freeUp } from './cloud.ts';
import { findDuplicates } from './dup.ts';
import { clearHistory, compareHistory, deleteHistory, exportFile, exportedFile, historyTrend, listHistory, saveHistory } from './history.ts';
import { brokenLinks } from './links.ts';
import { mftScan } from './mft.ts';
import { APP_VERSION, decodeTessera, hostName, saveScanFile } from './saved.ts';
import { Store } from './store.ts';
import { checkRoot, walkScan, type WalkOutcome } from './walk.ts';
import './walkworker.ts'; // registra el worker cuando este módulo se carga como tal
import { ATTR, Mem, isElevated, kernel32, lastError, ole32, quietErrors, readW, shell32, winErrorText, wstr, wstr2 } from './win32.ts';

export interface EngineOptions {
  /** Workers para el recorrido; 0 = hilo principal. Por defecto: la mitad de los hilos (2..8). */
  threads?: number;
  workerUrl?: string | URL;
  /** Registro de diagnóstico para desarrolladores (en inglés; nunca llega a la interfaz). */
  log?: (line: string) => void;
}

export const defaultThreads = () => Math.min(8, Math.max(2, Math.floor(availableParallelism() / 2)));

/** Normaliza una ruta de usuario: "c:" → "C:\", "C:/x/" → "C:\x". */
export function normalizePath(p: string): string {
  let s = (p || '').trim().replace(/\//g, '\\');
  if (/^[a-zA-Z]:$/.test(s)) s += '\\';
  if (!/^[a-zA-Z]:\\/.test(s) && !s.startsWith('\\\\')) throw engineError('error.invalidPath', { path: String(p ?? '') });
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

// Códigos heredados de SHFileOperation (no son errores Win32 y FormatMessage no los conoce): viajan
// en inglés en el parámetro `error` de action.failed. 0x75 (DE_OPCANCELLED) es action.cancelled.
const DE_CODES: Record<number, string> = {
  0x71: 'Source and destination are the same file', 0x78: 'Access denied',
  0x79: 'The path is too long', 0x7C: 'The path is not valid', 0x80: 'A file with that name already exists',
  0x402: 'Unknown error', 0x10000: 'Error at the destination',
};
const DE_OPCANCELLED = 0x75, ERROR_CANCELLED = 1223;

/** Resultado de una acción con su código traducible. */
const result = (ok: boolean, code: MessageCode, params?: MessageParams): ActionResult => ({ ok, ...msg(code, params) });
const failed = (error: string) => result(false, 'action.failed', { error });

/** Abre el Explorador con `path` seleccionado (o, con `openFolder`, la carpeta misma). */
export function revealPath(path: string, openFolder = false): ActionResult {
  ensureCom();
  const r = openFolder
    ? Number(shell32().ShellExecuteW(0n, wstr('open'), wstr(path), null, null, 1))
    : Number(shell32().ShellExecuteW(0n, wstr('open'), wstr('explorer.exe'), wstr(`/select,"${path}"`), null, 1));
  return r > 32 ? { ok: true } : failed(winErrorText(r));
}

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
  if (rc === DE_OPCANCELLED || rc === ERROR_CANCELLED) return result(false, 'action.cancelled');
  if (rc !== 0) return failed(DE_CODES[rc] ?? winErrorText(rc));
  if (m.dv.getInt32(36, true)) return result(false, 'action.cancelled'); // fAnyOperationsAborted
  if (exists(path)) return result(false, 'action.trashNotMoved');
  return result(true, 'action.trashed');
}

/** Avisos del recorrido: sólo cuántas carpetas no se pudieron leer (y unas pocas rutas de muestra). */
export function walkWarnings(w: Pick<WalkOutcome, 'denied' | 'deniedSample' | 'failed' | 'failedSample'>): EngineMessage[] {
  const out: EngineMessage[] = [];
  const params = (count: number, sample: string[]): MessageParams => sample.length ? { count, sample: sample.join(', ') } : { count };
  if (w.denied) out.push(msg('scan.accessDenied', params(w.denied, w.deniedSample)));
  if (w.failed) out.push(msg('scan.readErrors', params(w.failed, w.failedSample)));
  return out;
}

export class TesseraEngine {
  store: Store | null = null;
  result: ScanResult | null = null;
  /** Cuándo terminó el escaneo cargado (segundos Unix): el `scannedAt` del historial. */
  scannedAt = 0;
  /**
   * El escaneo cargado se abrió desde un archivo (openScan): de dónde viene. Mientras tanto, lo que mira o toca el
   * disco (acciones, rescan, refresh, duplicados, enlaces rotos) y el historial (guardar, comparar, evolución)
   * responden scan.offline. Un escaneo nuevo lo quita.
   */
  offline: SavedScanInfo | null = null;
  scanning = false;
  dupRunning = false;
  private cancelled = false;
  private dupCancelled = false;
  readonly elevated = isElevated();
  private opts: EngineOptions;

  constructor(opts: EngineOptions = {}) { this.opts = opts; quietErrors(); }

  volumes(): VolumeInfo[] { return volumes(); }

  elevation(): ElevationInfo { return { elevated: this.elevated, canElevate: !this.elevated }; }

  async scan(req: ScanRequest, onProgress: (p: ScanProgress) => void = () => { }): Promise<ScanResult> {
    if (this.scanning) throw engineError('error.scanBusy');
    if (this.dupRunning) throw engineError('error.dupBusy'); // la búsqueda usa el árbol actual
    // Una ruta no válida, inexistente o que no es carpeta se rechaza antes de soltar el árbol anterior,
    // que así sigue sirviendo a la interfaz
    const path = normalizePath(req.path);
    checkRoot(path);
    this.scanning = true; this.cancelled = false;
    const isCancelled = () => this.cancelled;
    // el árbol anterior se suelta ya: sus ids dejan de valer al terminar y así no conviven dos árboles en memoria
    // (y con él la comparación activa, que vive en el almacén, y el estado «sin conexión» de un escaneo abierto)
    this.store = null; this.result = null; this.scannedAt = 0; this.offline = null;
    Bun.gc(true);
    const t0 = performance.now();
    const ms = () => Math.round(performance.now() - t0);
    try {
      onProgress({ phase: 'starting', entries: 0, bytes: 0, elapsedMs: 0, detail: path });
      const vol = volumeInfo(volumeRoot(path));
      const isNtfs = vol?.fs.toUpperCase() === 'NTFS';
      const isDriveRoot = /^[A-Z]:\\$/.test(path);
      const warnings: EngineMessage[] = [];
      let engine: Engine = 'walk';
      let store: Store | null = null;
      let lastBytes = 0;
      const prog = (p: ScanProgress) => { lastBytes = p.bytes; onProgress(p); };

      const wantMft = req.engine === 'mft' || (req.engine === 'auto' && isDriveRoot);
      if (wantMft) {
        // Mismo orden que el motor Rust: primero lo que ni siquiera con administrador funcionaría
        if (!/^[A-Z]:\\/.test(path)) warnings.push(msg('scan.mftNetworkPath'));
        else if (!isNtfs) warnings.push(msg('scan.mftUnsupportedFs', { fs: vol?.fs || '?' }));
        else if (!this.elevated) warnings.push(msg('scan.mftNeedsAdmin'));
        else {
          try {
            const r = await mftScan(path, p => prog({ phase: p.phase, entries: p.entries, bytes: p.bytes, elapsedMs: ms(), detail: p.detail, fraction: p.fraction }), isCancelled);
            store = r.store; engine = 'mft'; warnings.push(...r.warnings);
          } catch (e) {
            if (e instanceof EngineError && e.code === 'error.cancelled') throw e;
            this.opts.log?.(`MFT scan failed, falling back to the walk: ${errorText(e)}`);
            warnings.push(msg('scan.mftFailed', { error: errorText(e) }));
          }
        }
      }
      if (!store) {
        const w = await walkScan(path, {
          threads: this.opts.threads ?? defaultThreads(), workerUrl: this.opts.workerUrl, trackKeys: isNtfs, isCancelled,
          onProgress: p => prog({ phase: 'walk', entries: p.entries, bytes: p.bytes, elapsedMs: ms(), detail: p.detail }),
        });
        store = w.store;
        for (const n of w.notes) this.opts.log?.(n);
        warnings.push(...walkWarnings(w));
        if (isNtfs) store.dedupHardlinks();
      }
      if (this.cancelled) throw engineError('error.cancelled');
      onProgress({ phase: 'aggregate', entries: store.n - 1, bytes: lastBytes, elapsedMs: ms() });
      await new Promise(r => setImmediate(r));
      store.finalize();
      this.store = store;
      const root = store.rootId;
      const result: ScanResult = {
        rootId: root, rootPath: path, engine, entries: store.n - 1, files: store.nf[root], dirs: store.nd[root],
        bytes: store.sz[root], elapsedMs: ms(), volume: vol, warnings,
      };
      this.result = result;
      this.scannedAt = Math.floor(Date.now() / 1000);
      onProgress({ phase: 'done', entries: result.entries, bytes: result.bytes, elapsedMs: result.elapsedMs });
      Bun.gc(true); // devuelve al sistema la basura del escaneo (lotes, crecimiento de arreglos)
      return result;
    } catch (e) {
      onProgress({ phase: 'error', entries: 0, bytes: 0, elapsedMs: ms() }); // el error en sí llega como EngineMessage
      throw e;
    } finally {
      this.scanning = false;
    }
  }

  /** Pide parar el escaneo (o rescan) en curso; se rechaza con error.cancelled. False si no había ninguno. */
  cancel(): boolean {
    if (!this.scanning) return false;
    this.cancelled = true;
    return true;
  }

  /**
   * Vuelve a recorrer una carpeta (no la raíz) y la injerta en el árbol cargado (Store.graft): la carpeta conserva su
   * id, lo de dentro estrena ids y el resto no cambia. Siempre con el recorrido (aunque el escaneo fuera por MFT) y
   * en un almacén aparte: cancelar deja el árbol como estaba. Mientras dura cuenta como un escaneo (`scanning`):
   * scan, duplicates, historySave y compare responden error.scanBusy; las consultas siguen viendo el árbol anterior.
   * Enlaces duros: se tratan como en un escaneo, pero sólo dentro de la carpeta; un archivo con otro nombre fuera
   * de ella puede quedar contado dos veces (limitación conocida, hasta el próximo escaneo completo).
   */
  async rescan(id: number, onProgress: (p: ScanProgress) => void = () => { }): Promise<RescanResult> {
    this.online();
    if (this.scanning) throw engineError('error.scanBusy');
    if (this.dupRunning) throw engineError('error.dupBusy');
    const s = this.need(id);
    if (id === s.rootId) throw engineError('rescan.root');
    const path = s.path(id);
    if (!s.isDir(id)) throw engineError('error.notFolder', { path });
    const ri = checkRoot(path); // ya no existe o ya no es carpeta: error.cannotOpen / error.notFolder, sin tocar nada
    // en marcha antes del primer await: un cancel() inmediato ya lo para
    this.scanning = true; this.cancelled = false;
    const isCancelled = () => this.cancelled;
    const t0 = performance.now();
    const ms = () => Math.round(performance.now() - t0);
    try {
      onProgress({ phase: 'walk', entries: 0, bytes: 0, elapsedMs: 0, detail: path });
      const warnings: EngineMessage[] = [];
      let sub: Store;
      if (s.fl[id] & FLAG.REPARSE) {
        // un punto de reanálisis (junction, enlace simbólico) no se sigue, como en el escaneo: queda vacío
        sub = new Store(1); sub.addRoot(path, ri.mtime, s.fl[id]);
      } else {
        const isNtfs = volumeInfo(volumeRoot(path))?.fs.toUpperCase() === 'NTFS';
        const w = await walkScan(path, {
          threads: this.opts.threads ?? defaultThreads(), workerUrl: this.opts.workerUrl, trackKeys: isNtfs, isCancelled,
          onProgress: p => onProgress({ phase: 'walk', entries: p.entries, bytes: p.bytes, elapsedMs: ms(), detail: p.detail }),
        });
        sub = w.store;
        for (const n of w.notes) this.opts.log?.(n);
        warnings.push(...walkWarnings(w));
        if (isNtfs) sub.dedupHardlinks();
        // lo que sale de la etiqueta de reparse (nube, WOF) no se lee en la raíz del recorrido: se conserva
        if (ri.attrs & ATTR.REPARSE) sub.fl[0] |= s.fl[id] & (FLAG.CLOUD | FLAG.COMPRESSED);
      }
      if (this.cancelled) throw engineError('error.cancelled');
      sub.finalize();
      // mientras tanto pudo ir a la papelera (ella o un antepasado)
      if (this.store !== s || !s.has(id)) throw engineError('error.invalidNode', { id });
      const oldCount = s.nf[id] + s.nd[id];
      const before = s.graft(id, sub);
      const r = this.result, root = s.rootId;
      if (r) this.result = { ...r, bytes: s.sz[root], files: s.nf[root], dirs: s.nd[root], entries: r.entries + sub.n - 1 - oldCount };
      const out: RescanResult = { row: s.row(id), before, entries: sub.n - 1, elapsedMs: ms(), warnings };
      onProgress({ phase: 'done', entries: out.entries, bytes: out.row.size, elapsedMs: out.elapsedMs });
      Bun.gc(true); // las columnas anteriores del árbol y el almacén del recorrido
      return out;
    } catch (e) {
      onProgress({ phase: 'error', entries: 0, bytes: 0, elapsedMs: ms() }); // el error en sí llega como EngineMessage
      throw e;
    } finally {
      this.scanning = false;
    }
  }

  /**
   * Actualizar con el diario USN sólo existe en el motor Rust (escritorio con administrador): aquí, siempre
   * refresh.unavailable (o scan.offline con un escaneo abierto desde archivo).
   */
  async refresh(_onProgress?: (p: ScanProgress) => void): Promise<RefreshResult> {
    this.online();
    throw engineError('refresh.unavailable');
  }

  /** Archivos duplicados bajo `root` (ver dup.ts). Exige un escaneo cargado y ninguna operación larga en curso. */
  async duplicates(req: DupRequest, onProgress: (p: DupProgress) => void = () => { }): Promise<DupResult> {
    this.online();
    if (this.scanning) throw engineError('error.scanBusy');
    if (this.dupRunning) throw engineError('error.dupBusy');
    const s = this.need(req.root);
    // en marcha antes del primer await: un cancelDuplicates() inmediato ya la para
    this.dupRunning = true; this.dupCancelled = false;
    try {
      return await findDuplicates(s, req.root, { minSize: req.minSize, limit: req.limit, onProgress, isCancelled: () => this.dupCancelled });
    } finally {
      this.dupRunning = false;
    }
  }

  /** Pide parar la búsqueda de duplicados; `duplicates` se rechaza con error.cancelled. False si no había ninguna. */
  cancelDuplicates(): boolean {
    if (!this.dupRunning) return false;
    this.dupCancelled = true;
    return true;
  }

  // ---------- historial y comparación (history.ts) ----------
  /** Guarda el escaneo cargado en el historial. Se permite durante una búsqueda de duplicados, no durante un escaneo. */
  historySave(): HistoryEntry {
    this.online();
    if (this.scanning) throw engineError('error.scanBusy');
    const s = this.store, r = this.result;
    if (!s || !r) throw engineError('error.noScan');
    return saveHistory(s, r.engine, this.scannedAt);
  }

  historyList(): HistoryEntry[] { return listHistory(); }
  historyDelete(id: string): boolean { return deleteHistory(id); }
  historyClear(): number { return clearHistory(); }

  /**
   * Evolución del nodo `id` en los resúmenes de su raíz, del más antiguo al más reciente, sin el del escaneo cargado
   * (history.ts › historyTrend). Errores: error.noScan, scan.offline, error.invalidNode.
   */
  historyTrend(id: number): TrendPoint[] {
    if (!this.store) throw engineError('error.noScan');
    this.online();
    return historyTrend(this.need(id), id, this.scannedAt);
  }

  /** Compara con un resumen de la misma ruta y deja la comparación activa (hasta compareClear o un escaneo nuevo). */
  compare(id: string, limit: number): CompareResult {
    this.online();
    if (this.scanning) throw engineError('error.scanBusy');
    if (!this.store) throw engineError('error.noScan');
    return compareHistory(this.store, id, limit);
  }

  compareClear(): void { this.store?.setCompare(null); }

  // ---------- escaneo guardado (saved.ts) ----------
  /**
   * Guarda el escaneo cargado COMPLETO como `<raíz> <fecha>.tessera` en la carpeta de exportación. Uno abierto desde
   * archivo conserva su scannedAt, host y app. Errores: error.noScan, export.failed.
   */
  saveScan(): ExportResult {
    const s = this.store, r = this.result;
    if (!s || !r) throw engineError('error.noScan');
    const o = this.offline;
    return saveScanFile(s, {
      app: o ? o.app : APP_VERSION, host: o ? o.host : hostName(), scannedAt: this.scannedAt, engine: r.engine, volume: r.volume,
    });
  }

  /**
   * Abre un escaneo guardado (el contenido de un .tessera) y sustituye al cargado, como un escaneo nuevo (ids
   * nuevos, sin comparación), en estado «sin conexión». Se lee entero antes de soltar el árbol anterior: un archivo
   * dañado (scan.openFailed) lo deja como estaba. Mismos cerrojos que un escaneo (error.scanBusy / error.dupBusy).
   */
  openScan(data: Uint8Array | ArrayBuffer): ScanResult {
    if (this.scanning) throw engineError('error.scanBusy');
    if (this.dupRunning) throw engineError('error.dupBusy');
    const t0 = performance.now();
    const f = decodeTessera(data instanceof Uint8Array ? data : new Uint8Array(data));
    const s = f.store, root = s.rootId;
    const offline: SavedScanInfo = { scannedAt: f.scannedAt, ...(f.host ? { host: f.host } : {}), ...(f.app ? { app: f.app } : {}) };
    this.store = s;
    this.scannedAt = f.scannedAt;
    this.offline = offline;
    const result: ScanResult = {
      rootId: root, rootPath: s.rootPath, engine: f.engine, entries: s.n - 1, files: s.nf[root], dirs: s.nd[root],
      bytes: s.sz[root], elapsedMs: Math.round(performance.now() - t0), volume: f.volume, warnings: [], canRefresh: false, offline,
    };
    this.result = result;
    Bun.gc(true); // el árbol anterior y el JSON descomprimido
    return result;
  }

  /** Lo que mira o toca el disco no vale con un escaneo abierto desde archivo. */
  private online() {
    if (this.offline) throw engineError('scan.offline');
  }

  // ---------- exportación ----------
  exportFile(name: string, data: string, base64: boolean): ExportResult { return exportFile(name, data, base64); }

  /** Abre el Explorador con un archivo exportado seleccionado (sólo dentro de la carpeta de exportación). */
  revealExport(path: string): ActionResult { return revealPath(exportedFile(path)); }

  private need(id: number): Store {
    const s = this.store;
    if (!s) throw engineError('error.noScan');
    if (!s.has(id)) throw engineError('error.invalidNode', { id: Number.isFinite(id) ? id : String(id) });
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

  /**
   * Enlaces rotos bajo `root` (links.ts), ordenados por ruta. Mira cada enlace en el disco cediendo el hilo de vez en
   * cuando (el servidor sigue respondiendo); si mientras tanto se carga otro escaneo, error.invalidNode (o
   * error.noScan si aún no hay árbol). Sin escaneo o con un nodo no válido, lanza como search.
   */
  async brokenLinks(root: number, limit: number): Promise<SearchResponse> {
    this.online();
    const s = this.need(root);
    const verify = () => {
      if (!this.store) throw engineError('error.noScan');
      if (this.store !== s) throw engineError('error.invalidNode', { id: root });
    };
    return brokenLinks(s, root, limit, { log: this.opts.log, verify });
  }
  nodePath(id: number): string { return this.need(id).path(id); }
  nodeInfo(id: number): NodeRow { return this.need(id).row(id); }

  /** Acciones sobre el disco; con un escaneo abierto desde archivo, todas lanzan scan.offline. */
  action(kind: ActionKind, id: number): ActionResult {
    this.online();
    const s = this.need(id);
    const path = s.path(id);
    switch (kind) {
      case 'open': {
        ensureCom();
        const r = Number(shell32().ShellExecuteW(0n, wstr('open'), wstr(path), null, null, 1));
        return r > 32 ? { ok: true } : failed(winErrorText(r));
      }
      case 'reveal': return revealPath(path, id === s.rootId);
      case 'properties': {
        const err = shellExecuteEx('properties', path, null, null, 5, 0x0000000C /* INVOKEIDLIST */ | 0x00000400 /* FLAG_NO_UI */);
        return err === ERROR_CANCELLED ? result(false, 'action.cancelled') : err ? failed(winErrorText(err)) : { ok: true };
      }
      case 'trash': {
        if (id === s.rootId) return result(false, 'action.trashRoot');
        const r = trashPath(path);
        if (r.ok) s.remove(id);
        return r;
      }
      // sólo cambia atributos (nunca borra) y no toca el árbol: el proveedor vacía los archivos después (cloud.ts)
      case 'freeUp': return freeUp(s, id);
      default:
        return result(false, 'action.unknown', { kind: String(kind) });
    }
  }
}
