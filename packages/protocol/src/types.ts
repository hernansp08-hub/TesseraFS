// Contrato entre la interfaz y los motores (Rust/Tauri y Bun). Ver docs/ARQUITECTURA.md.

export const FLAG = {
  DIR: 1, HIDDEN: 2, SYSTEM: 4, HARDLINK: 8, COMPRESSED: 16, REPARSE: 32, CLOUD: 64, SPARSE: 128,
} as const;

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
  detail?: string;   // ruta actual o mensaje
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
  warnings: string[]; // p. ej. "MFT no disponible sin administrador: se usó el recorrido"
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
export interface SearchResponse { total: number; totalBytes: number; rows: SearchRow[]; error?: string }

export interface ExtStat { ext: string; size: number; alloc: number; count: number }

export type ActionKind = 'open' | 'reveal' | 'properties' | 'trash';
export interface ActionResult { ok: boolean; message?: string }

export interface ElevationInfo { elevated: boolean; canElevate: boolean }

/** Lo que la interfaz necesita de un motor. Implementaciones: demo, tauri, http. */
export interface Backend {
  readonly kind: 'demo' | 'tauri' | 'http';
  volumes(): Promise<VolumeInfo[]>;
  scan(req: ScanRequest, onProgress: (p: ScanProgress) => void): Promise<ScanResult>;
  slice(root: number, minBytes: number, maxNodes: number): Promise<ArrayBuffer>;
  children(req: ChildrenRequest): Promise<ChildrenResponse>;
  search(req: SearchRequest): Promise<SearchResponse>;
  extStats(root: number): Promise<ExtStat[]>;
  nodePath(id: number): Promise<string>;
  nodeInfo(id: number): Promise<NodeRow>;
  action(kind: ActionKind, id: number): Promise<ActionResult>;
  elevation(): Promise<ElevationInfo>;
  relaunchElevated(): Promise<void>;
}
