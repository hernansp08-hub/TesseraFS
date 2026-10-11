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
  /** true si `refresh()` puede actualizar con el diario USN de NTFS (escritorio, con administrador). */
  canRefresh?: boolean;
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
  /** Sólo con una comparación activa (ver `compare`): tamaño en el escaneo anterior, si se conoce. */
  prev?: number;
  /** Sólo con una comparación activa: no existía en el escaneo anterior. */
  fresh?: boolean;
}

/** `delta`: crecimiento desde el escaneo comparado (size − prev; lo nuevo cuenta entero; lo desconocido, 0). */
export type SortKey = 'size' | 'alloc' | 'name' | 'files' | 'mtime' | 'delta';

export interface ChildrenRequest { id: number; offset: number; limit: number; sort: SortKey; desc: boolean }
export interface ChildrenResponse { total: number; rows: NodeRow[] }

export interface SearchRequest { query: string; root: number; limit: number }
export interface SearchRow extends NodeRow { path: string }
export interface SearchResponse { total: number; totalBytes: number; rows: SearchRow[]; error?: EngineMessage }

export interface ExtStat { ext: string; size: number; alloc: number; count: number }

/**
 * `freeUp`: libera espacio de OneDrive (u otro proveedor de archivos en la nube) sin borrar: los archivos con FLAG.CLOUD
 * que están descargados pasan a «sólo en línea» (atributo UNPINNED, sin PINNED), como «Liberar espacio» del Explorador.
 * El proveedor los vacía después, en segundo plano. Sobre una carpeta, se aplica a todo lo que contiene.
 */
export type ActionKind = 'open' | 'reveal' | 'properties' | 'trash' | 'freeUp';
/** `code` + `params` se traducen en la interfaz; `message` es el texto del sistema o de reserva en inglés. */
export interface ActionResult { ok: boolean; code?: string; params?: Record<string, string | number>; message?: string }

export interface ElevationInfo { elevated: boolean; canElevate: boolean }

// ---------- Sistema ----------
export type Os = 'windows' | 'linux' | 'macos';
/** Dónde corre el motor: la interfaz adapta las rutas, los textos y las acciones que ofrece. */
export interface SystemInfo {
  os: Os;
  /** Separador de rutas: '\\' en Windows, '/' en el resto. */
  sep: '\\' | '/';
  /** Acciones disponibles aquí (Windows: todas; Linux: open, reveal, trash); la interfaz oculta las demás. */
  actions: ActionKind[];
  /**
   * Carpeta o unidad pedida al abrir la app («Analizar con TesseraFS» en el menú del Explorador, o
   * `tesserafs-desktop <ruta>`): la interfaz la escanea al arrancar en vez de mostrar las unidades.
   */
  launchPath?: string;
}

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

// ---------- Historial y comparación ----------
/**
 * Resumen de un escaneo guardado en %LOCALAPPDATA%\TesseraFS\history: todas las carpetas y los archivos de
 * 1 MiB o más. Lo comparten las dos ediciones (formato en docs/ARQUITECTURA.md).
 */
export interface HistoryEntry {
  id: string;          // "20261010T174512Z-1a2b3c4d": fecha UTC + hash de la ruta
  path: string;        // raíz escaneada, "C:\\"
  scannedAt: number;   // segundos Unix
  engine: Engine;
  bytes: number;
  files: number;
  dirs: number;
  nodes: number;       // nodos guardados
  fileBytes: number;   // lo que ocupa el resumen en disco
}
/** Un elemento actual con su tamaño anterior; `prev: null` = no existía. */
export interface ChangeRow extends Omit<SearchRow, 'prev' | 'fresh'> { prev: number | null }
/** Lo que existía y ya no: sólo el elemento más alto (no sus descendientes). */
export interface RemovedRow { path: string; isDir: boolean; size: number }
export interface CompareResult {
  entry: HistoryEntry;
  before: { bytes: number; files: number; dirs: number };
  after: { bytes: number; files: number; dirs: number };
  /**
   * Lo que explica el crecimiento, de más a menos: elementos que crecieron (o son nuevos) sin que un solo hijo
   * explique el 75 % o más de su crecimiento; así no se repiten todas las carpetas padre. Hasta `limit`.
   */
  grew: ChangeRow[];
  shrank: ChangeRow[];   // igual, para lo que se redujo (el que más primero)
  removed: RemovedRow[]; // hasta `limit`, por tamaño
}

// ---------- Volver a escanear y actualizar ----------
/** Resultado de volver a escanear una carpeta: la misma carpeta (mismo id) con su contenido nuevo. */
export interface RescanResult {
  row: NodeRow;            // la carpeta ya actualizada
  before: number;          // su tamaño antes
  entries: number;         // elementos leídos
  elapsedMs: number;
  warnings: EngineMessage[]; // scan.accessDenied / scan.readErrors, como en el escaneo
}
/** Resultado de `refresh()`: lo que el diario USN dijo que cambió, ya vuelto a escanear. */
export interface RefreshResult {
  folders: number;         // carpetas vueltas a escanear
  records: number;         // registros del diario leídos
  before: number;          // tamaño de la raíz antes
  after: number;           // y después
  elapsedMs: number;
  warnings: EngineMessage[];
}

/** Archivo exportado en Descargas\TesseraFS. */
export interface ExportResult { path: string }

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
  /** Guarda en el historial el escaneo cargado. Conserva los 20 más recientes de cada ruta. */
  historySave(): Promise<HistoryEntry>;
  /** Todo el historial, el más reciente primero. */
  historyList(): Promise<HistoryEntry[]>;
  historyDelete(id: string): Promise<boolean>;
  /** Borra todo el historial; devuelve cuántos resúmenes borró. */
  historyClear(): Promise<number>;
  /**
   * Compara el escaneo cargado con un resumen de la misma ruta y deja la comparación activa: desde entonces
   * las filas llevan `prev`/`fresh` y `children` admite `sort: 'delta'`. Un escaneo nuevo la desactiva.
   */
  compare(id: string, limit: number): Promise<CompareResult>;
  compareClear(): Promise<void>;
  /** Guarda un archivo en Descargas\TesseraFS (nombre sin rutas; si existe, añade « (2)»…). */
  exportFile(name: string, data: string, base64: boolean): Promise<ExportResult>;
  /** Abre el Explorador con un archivo exportado seleccionado (sólo dentro de Descargas\TesseraFS). */
  revealExport(path: string): Promise<ActionResult>;
  /**
   * Vuelve a escanear una carpeta (no la raíz) y la sustituye en el árbol: los ids del resto no cambian; los de
   * su interior, sí. Quita la comparación activa. Progreso como el del escaneo; se cancela con `cancelScan`.
   */
  rescan(id: number, onProgress: (p: ScanProgress) => void): Promise<RescanResult>;
  /**
   * Lee el diario USN desde el último escaneo o actualización y vuelve a escanear sólo las carpetas que cambiaron.
   * Sólo si `ScanResult.canRefresh`; si no, `refresh.unavailable`. Si el diario se reinició o perdió registros,
   * `refresh.journalReset` (la interfaz hace entonces un escaneo completo).
   */
  refresh(onProgress: (p: ScanProgress) => void): Promise<RefreshResult>;
  elevation(): Promise<ElevationInfo>;
  relaunchElevated(): Promise<void>;
  system(): Promise<SystemInfo>;
  /**
   * Enlaces rotos bajo `root`: enlaces simbólicos, uniones (junctions) y carpetas montadas cuyo destino ya no
   * existe. Sólo los puntos de reanálisis que sustituyen un nombre (no OneDrive, WOF, deduplicación ni alias de
   * aplicaciones). Comprueba cada destino en el momento; ordenados por ruta, `total` = todos los rotos.
   */
  brokenLinks(root: number, limit: number): Promise<SearchResponse>;
}
