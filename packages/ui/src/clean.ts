// «Liberar espacio» y «¿Qué es esto?»: reglas explicadas que se ejecutan como filtros, y carpetas conocidas.
// Sin dependencias de la interfaz para poder probarlas (test/clean.test.ts). Los textos van en el catálogo:
//   regla:   clean.<id>.title · clean.<id>.why · clean.<how>.how (si `how`)
//   conocida: known.<id>
export type Risk = 'ok' | 'warn' | 'bad';
/** Lo que una regla necesita de un elemento (una fila de búsqueda cumple esta forma). */
export interface Target { name: string; path: string; isDir: boolean; ext: string; size?: number; alloc?: number }
export type Key = [key: string, params?: Record<string, string>];

export interface Rule {
  id: string;
  /** Consulta del lenguaje de búsqueda que trae los candidatos; `ok` los afina por ruta. */
  q: string;
  risk: Risk;
  ok?: (t: Target) => boolean;
  /** Nombres de hijos que confirman el candidato (p. ej. CACHEDIR.TAG en un target de Rust). */
  needs?: string[];
  /** Título que depende del elemento (el juego, el navegador…); si no, clean.<id>.title. */
  title?: (t: Target) => Key;
  cmd?: string | ((t: Target) => string | undefined);
  /** Id de la regla cuyo texto «cómo» se muestra (true = el suyo). */
  how?: true | string;
  /** El tamaño que cuenta es el que ocupa en disco (alloc), no el lógico: p. ej. OneDrive descargado. */
  useAlloc?: boolean;
  /** Acción propia de la tarjeta en lugar de marcar para borrar. */
  action?: 'freeUp';
  /** Agrupa los archivos por carpeta en una sola tarjeta. */
  group?: boolean;
  /** Tamaño mínimo para proponerlo. */
  min?: number;
}

const MB = 1024 ** 2, GB = 1024 ** 3;
// Carpetas que pertenecen a programas instalados: sus dependencias no se regeneran solas
const INSTALLED = /\\(Program Files( \(x86\))?|AppData|ProgramData|\.cache|\.vscode[^\\]*|\.cursor|Windows)\\|\\resources\\app\\|\\extensions\\/i;

const BROWSERS: [RegExp, string][] = [
  [/\\Google\\Chrome\\User Data\\[^\\]+\\(Cache|Code Cache)$/i, 'Chrome'],
  [/\\Microsoft\\Edge\\User Data\\[^\\]+\\(Cache|Code Cache)$/i, 'Edge'],
  [/\\BraveSoftware\\Brave-Browser\\User Data\\[^\\]+\\(Cache|Code Cache)$/i, 'Brave'],
  [/\\Vivaldi\\User Data\\[^\\]+\\(Cache|Code Cache)$/i, 'Vivaldi'],
  [/\\Mozilla\\Firefox\\Profiles\\[^\\]+\\cache2$/i, 'Firefox'],
];
// Cachés de gestores de paquetes de desarrollo: herramienta y la orden que la vacía
const PACKAGE_CACHES: [RegExp, string, string][] = [
  [/\\AppData\\Local\\npm-cache$/i, 'npm', 'npm cache clean --force'],
  [/\\AppData\\Local\\pnpm\\store$|\\AppData\\Local\\pnpm-store$|\\\.pnpm-store$/i, 'pnpm', 'pnpm store prune'],
  [/\\AppData\\Local\\Yarn\\Cache$/i, 'Yarn', 'yarn cache clean'],
  [/\\\.bun\\install\\cache$/i, 'Bun', 'bun pm cache rm'],
  [/\\AppData\\Local\\pip\\cache$/i, 'pip', 'pip cache purge'],
  [/\\AppData\\Local\\uv\\cache$/i, 'uv', 'uv cache clean'],
  [/\\\.nuget\\packages$/i, 'NuGet', 'dotnet nuget locals all --clear'],
  [/\\AppData\\Local\\go-build$/i, 'Go', 'go clean -cache'],
];
/** Sin comprimir: ocupa en disco al menos el 90 % de su tamaño (sin datos, se supone que sí). */
const uncompressed = (t: Target) => t.size == null || t.alloc == null || t.alloc >= t.size * .9;
const browserOf = (p: string) => BROWSERS.find(([re]) => re.test(p))?.[1];
const packageCacheOf = (p: string) => PACKAGE_CACHES.find(([re]) => re.test(p));

export const RULES: Rule[] = [
  // ---- Seguro: se regenera o es temporal ----
  { id: 'rustTarget', q: 'type:dir name:target', risk: 'ok', cmd: 'cargo clean', needs: ['cachedir.tag', '.rustc_info.json'],
    ok: t => t.name.toLowerCase() === 'target' && !INSTALLED.test(t.path), min: 50 * MB },
  { id: 'nodeModules', q: 'type:dir name:node_modules', risk: 'ok', cmd: 'bun install',
    ok: t => t.name === 'node_modules' && (t.path.match(/\\node_modules(?=\\|$)/gi) || []).length === 1 && !INSTALLED.test(t.path), min: 20 * MB },
  { id: 'venv', q: 'type:dir name:.venv', risk: 'ok', cmd: 'uv sync', ok: t => t.name === '.venv' && !INSTALLED.test(t.path), min: 20 * MB },
  { id: 'packageCaches', q: 'type:dir re:^(npm-cache|store|pnpm-store|\\.pnpm-store|cache|packages|go-build)$', risk: 'ok',
    ok: t => !!packageCacheOf(t.path), title: t => ['clean.packageCaches.title', { name: packageCacheOf(t.path)?.[1] ?? t.name }],
    cmd: t => packageCacheOf(t.path)?.[2], min: 200 * MB },
  { id: 'browserCache', q: 'type:dir re:^(Cache|Code.Cache|cache2)$', risk: 'ok', how: true,
    ok: t => !!browserOf(t.path), title: t => ['clean.browserCache.title', { name: browserOf(t.path) ?? t.name }], min: 100 * MB },
  { id: 'temp', q: 'type:dir name:Temp', risk: 'ok', how: true, ok: t => /\\AppData\\Local\\Temp$|^[A-Z]:\\Windows\\Temp$/i.test(t.path), min: 50 * MB },
  { id: 'windowsUpdate', q: 'type:dir name:SoftwareDistribution', risk: 'ok', how: true, ok: t => /^[A-Z]:\\Windows\\SoftwareDistribution$/i.test(t.path), min: 100 * MB },
  { id: 'deliveryOptimization', q: 'type:dir name:DeliveryOptimization', risk: 'ok', how: 'temp',
    ok: t => /^[A-Z]:\\Windows\\(ServiceProfiles\\NetworkService\\AppData\\Local\\Microsoft\\Windows|SoftwareDistribution)\\DeliveryOptimization$/i.test(t.path), min: 100 * MB },
  { id: 'crashDumps', q: 'type:dir re:^(Minidump|LiveKernelReports|CrashDumps|ReportArchive|ReportQueue)$ OR type:file name:MEMORY.DMP', risk: 'ok', how: 'temp',
    ok: t => /^[A-Z]:\\Windows\\(Minidump|LiveKernelReports|MEMORY\.DMP)$|\\AppData\\Local\\CrashDumps$|\\Microsoft\\Windows\\WER\\(ReportArchive|ReportQueue)$/i.test(t.path), min: 50 * MB },
  { id: 'shaderCache', q: 'type:dir re:^(D3DSCache|DXCache|GLCache|DxcCache|VkCache|ShaderCache|shadercache)$', risk: 'ok',
    ok: t => /\\AppData\\Local\\(D3DSCache|NVIDIA\\(DXCache|GLCache)|AMD\\(DxCache|DxcCache|VkCache)|Intel\\ShaderCache)$|\\steamapps\\shadercache$/i.test(t.path), min: 200 * MB },
  { id: 'windowsOld', q: 'type:dir name:Windows.old', risk: 'ok', how: true, ok: t => /^[A-Z]:\\Windows\.old$/i.test(t.path) },
  { id: 'recycleBin', q: 'type:dir name:$Recycle.Bin', risk: 'ok', how: true, ok: t => /^[A-Z]:\\\$Recycle\.Bin$/i.test(t.path), min: 10 * MB },
  // ---- Revisar: es tuyo, decides tú ----
  { id: 'aiModels', q: 'ext:gguf,safetensors,ckpt,onnx', risk: 'warn', group: true, ok: t => /^(gguf|safetensors|ckpt|onnx)$/i.test(t.ext), min: 500 * MB },
  { id: 'virtualDisks', q: 'ext:vhdx,vhd', risk: 'warn', cmd: 'wsl --manage <distro> --set-sparse true', ok: t => /^vhdx?$/i.test(t.ext), min: 500 * MB },
  { id: 'game', q: 'type:dir path:steamapps', risk: 'warn', title: t => ['clean.game.title', { name: t.name }], ok: t => /\\steamapps\\common\\[^\\]+$/i.test(t.path), min: 1 * GB,
    // Sin desinstalarlo: comprimirlo con WOF (se lee igual; sólo si aún no está comprimido)
    cmd: t => uncompressed(t) ? `compact /c /s /i /q /exe:lzx "${t.path}\\*"` : undefined, how: true },
  // OneDrive: lo descargado en este equipo puede quedarse sólo en la nube sin borrar nada
  { id: 'oneDrive', q: 'type:dir name:OneDrive', risk: 'ok', useAlloc: true, action: 'freeUp', how: true,
    ok: t => /^[A-Z]:\\Users\\[^\\]+\\OneDrive( - [^\\]+)?$/i.test(t.path), min: 200 * MB },
  { id: 'downloads', q: 'path:Downloads ext:msi,exe,iso,zip,7z size:>100m', risk: 'warn', group: true, min: 200 * MB },
  { id: 'restorePoints', q: 'type:dir name:"System Volume Information"', risk: 'warn', cmd: 'vssadmin list shadowstorage', ok: t => /^[A-Z]:\\System Volume Information$/i.test(t.path), min: 100 * MB },
  // ---- No borrar a mano: lo gestiona Windows ----
  { id: 'systemFile', q: 'pagefile.sys OR hiberfil.sys OR swapfile.sys', risk: 'bad', ok: t => /^[A-Z]:\\(pagefile|hiberfil|swapfile)\.sys$/i.test(t.path),
    title: t => [t.name.toLowerCase() === 'hiberfil.sys' ? 'clean.hiberfil.title' : t.name.toLowerCase() === 'swapfile.sys' ? 'clean.swapfile.title' : 'clean.pagefile.title'] },
  { id: 'winsxs', q: 'type:dir name:WinSxS', risk: 'bad', cmd: 'DISM /Online /Cleanup-Image /StartComponentCleanup', ok: t => /^[A-Z]:\\Windows\\WinSxS$/i.test(t.path) },
  { id: 'installer', q: 'type:dir name:Installer', risk: 'bad', ok: t => /^[A-Z]:\\Windows\\Installer$/i.test(t.path) },
  { id: 'packageCache', q: 'type:dir name:"Package Cache"', risk: 'bad', ok: t => /^[A-Z]:\\ProgramData\\Package Cache$/i.test(t.path), min: 500 * MB },
  { id: 'driverStore', q: 'type:dir name:FileRepository', risk: 'bad', cmd: 'pnputil /enum-drivers', ok: t => /^[A-Z]:\\Windows\\System32\\DriverStore\\FileRepository$/i.test(t.path), min: 1 * GB },
];

/** Carpetas que conviene explicar aunque no sean candidatas a limpieza (texto: known.<id>). */
export const KNOWN: [id: string, re: RegExp][] = [
  ['windows', /^[A-Z]:\\Windows$/i],
  ['system32', /^[A-Z]:\\Windows\\(System32|SysWOW64)$/i],
  ['prefetch', /^[A-Z]:\\Windows\\Prefetch$/i],
  ['windowsApps', /^[A-Z]:\\Program Files\\WindowsApps$/i],
  ['programFiles', /^[A-Z]:\\Program Files( \(x86\))?$/i],
  ['programData', /^[A-Z]:\\ProgramData$/i],
  ['recovery', /^[A-Z]:\\Recovery$/i],
  ['users', /^[A-Z]:\\Users$/i],
  ['appData', /^[A-Z]:\\Users\\[^\\]+\\AppData$/i],
  ['storePackages', /\\AppData\\Local\\Packages$/i],
  ['oneDrive', /^[A-Z]:\\Users\\[^\\]+\\OneDrive( - [^\\]+)?$/i],
  ['downloads', /^[A-Z]:\\Users\\[^\\]+\\Downloads$/i],
  ['steamapps', /\\steamapps$/i],
];

/** Carpeta o archivo que la regla busca: con «type:dir» y «type:file» a la vez, ambos. */
export function ruleKind(r: Rule): 'dir' | 'file' | 'any' {
  const d = /\btype:dir\b/.test(r.q), f = /\btype:file\b/.test(r.q);
  return d && f ? 'any' : d ? 'dir' : 'file';
}
/** ¿La regla describe este elemento? (sin `needs`, que requiere preguntar al motor por sus hijos) */
export function ruleMatches(r: Rule, t: Target): boolean {
  if (!r.ok) return false;
  const k = ruleKind(r);
  if ((k === 'dir' && !t.isDir) || (k === 'file' && t.isDir)) return false;
  return r.ok(t);
}
export const cmdOf = (r: Rule, t: Target) => typeof r.cmd === 'function' ? r.cmd(t) : r.cmd;
export const titleOf = (r: Rule, t: Target): Key => r.title ? r.title(t) : [`clean.${r.id}.title`];
export const howKey = (r: Rule) => r.how ? `clean.${r.how === true ? r.id : r.how}.how` : '';
export const knownId = (path: string) => KNOWN.find(([, re]) => re.test(path))?.[0];
