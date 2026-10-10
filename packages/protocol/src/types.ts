// Contrato entre la interfaz y los motores (Rust/Tauri y Bun). Ver docs/ARQUITECTURA.md.

export const FLAG = {
  DIR: 1, HIDDEN: 2, SYSTEM: 4, HARDLINK: 8, COMPRESSED: 16, REPARSE: 32, CLOUD: 64, SPARSE: 128,
} as const;

/**
 * Mensaje para el usuario emitido por un motor. La interfaz lo traduce con la clave `engine.<code>`
 * del catálogo; `message` es el texto en inglés, de reserva y para registros. Ver docs/tecnica/i18n.md.
 */
export interface EngineMessage {
  code: string;
  params?: Record<string, string | number>;
  message: string;
}

export type Engine = 'mft' | 'walk';
export type EngineChoice = 'auto' | Engine;

export interface VolumeInfo {
  path: string;        // "C:\\"
  label: string;       // "Windows-SSD"
  fs: string;          // "NTFS"
  total: number;       // bytes
  free: number;        // bytes
  clusterSize: number; // bytes
}

export interface ScanRequest { path: string; engine: EngineChoice }

export type ScanPhase = 'starting' | 'mft-read' | 'walk' | 'link' | 'aggregate' | 'done' | 'error';

export interface ScanProgress {
  phase: ScanPhase;
  entries: number;   // registros / entradas procesadas
  bytes: number;     // bytes acumulados (lógicos)
  elapsedMs: number;
  detail?: string;   // ruta actual (nunca texto para el usuario: la fase la traduce la interfaz)
  fraction?: number; // 0..1 cuando el motor conoce el total de trabajo (p. ej. lectura de la MFT)
}

export interface ScanResult {
  rootId: number;
  rootPath: string;
  engine: Engine;
  entries: number;
  files: number;
  dirs: number;
  bytes: number;
  elapsedMs: number;
  volume: VolumeInfo | null;
  warnings: EngineMessage[]; // p. ej. { code: 'scan.mftNeedsAdmin', message: 'MFT unavailable…' }
}

export interface NodeRow {
  id: number;
  parentId: number;  // -1 en la raíz
  name: string;
  isDir: boolean;
  size: number;
  alloc: number;
  files: number;     // archivos descendientes (0 en archivos)
  dirs: number;      // carpetas descendientes
  mtime: number;     // segundos Unix
  ext: string;       // minúsculas, sin punto; "" en carpetas o sin extensión
  flags: number;
  childCount: number;
}

export type SortKey = 'size' | 'alloc' | 'name' | 'files' | 'mtime';

export interface ChildrenRequest { id: number; offset: number; limit: number; sort: SortKey; desc: boolean }
export interface ChildrenResponse { total: number; rows: NodeRow[] }

export interface SearchRequest { query: string; root: number; limit: number }
export interface SearchRow extends NodeRow { path: string }
export interface SearchResponse { total: number; totalBytes: number; rows: SearchRow[]; error?: EngineMessage }

export interface ExtStat { ext: string; size: number; alloc: number; count: number }

export type ActionKind = 'open' | 'reveal' | 'properties' | 'trash';
/** `code` + `params` se traducen en la interfaz; `message` es el texto del sistema o de reserva en inglés. */
export interface ActionResult { ok: boolean; code?: string; params?: Record<string, string | number>; message?: string }

export interface ElevationInfo { elevated: boolean; canElevate: boolean }

// ---------- Duplicados ----------
/**
 * Busca archivos con el mismo contenido bajo `root`, en tres pasadas: tamaño (sin leer nada), los primeros
 * 64 KiB y el contenido completo (hash criptográfico de 256 bits). Excluye enlaces duros (FLAG.HARDLINK: borrar
 * uno no libera nada), archivos sólo en la nube (FLAG.CLOUD: leerlos los descargaría), puntos de reanálisis y
 * archivos por debajo de `minSize`. Devuelve los `limit` grupos con más espacio recuperable.
 */
export interface DupRequest { root: number; minSize: number; limit: number }
export type DupPhase = 'size' | 'prefix' | 'full' | 'done';
export interface DupProgress {
  phase: DupPhase;
  files: number;       // archivos leídos en la pasada actual
  totalFiles: number;  // candidatos de la pasada actual
  bytes: number;       // bytes leídos en la pasada actual
  totalBytes: number;  // bytes que leerá la pasada actual
  elapsedMs: number;
}
export interface DupGroup {
  size: number;        // tamaño de cada copia
  hash: string;        // hex del hash del contenido (identifica el grupo)
  files: SearchRow[];  // ≥ 2, ordenados por ruta
}
export interface DupResult {
  groups: DupGroup[];      // ordenados por espacio recuperable, (n − 1) × size, de mayor a menor
  totalGroups: number;     // grupos encontrados (puede ser > groups.length)
  wasted: number;          // espacio recuperable de todos los grupos encontrados
  candidates: number;      // archivos con tamaño repetido (primera pasada)
  readBytes: number;       // bytes leídos en total
  skipped: { hardlinks: number; cloud: number };
  elapsedMs: number;
  warnings: EngineMessage[]; // p. ej. { code: 'dup.readErrors', params: { count } }
}

/** Lo que la interfaz necesita de un motor. Implementaciones: demo, tauri, http. */
export interface Backend {
  readonly kind: 'demo' | 'tauri' | 'http';
  volumes(): Promise<VolumeInfo[]>;
  scan(req: ScanRequest, onProgress: (p: ScanProgress) => void): Promise<ScanResult>;
  /** Pide parar el escaneo en curso: `scan` se rechaza con `error.cancelled`. Devuelve false si no había ninguno. */
  cancelScan(): Promise<boolean>;
  slice(root: number, minBytes: number, maxNodes: number): Promise<ArrayBuffer>;
  children(req: ChildrenRequest): Promise<ChildrenResponse>;
  search(req: SearchRequest): Promise<SearchResponse>;
  extStats(root: number): Promise<ExtStat[]>;
  nodePath(id: number): Promise<string>;
  nodeInfo(id: number): Promise<NodeRow>;
  action(kind: ActionKind, id: number): Promise<ActionResult>;
  /** Exige un escaneo cargado y ninguna operación larga en curso (si no, `error.scanBusy` o `error.dupBusy`). */
  duplicates(req: DupRequest, onProgress: (p: DupProgress) => void): Promise<DupResult>;
  /** Pide parar la búsqueda de duplicados: `duplicates` se rechaza con `error.cancelled`. False si no había ninguna. */
  cancelDuplicates(): Promise<boolean>;
  elevation(): Promise<ElevationInfo>;
  relaunchElevated(): Promise<void>;
}
