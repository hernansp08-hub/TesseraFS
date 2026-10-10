// Reglas de «Liberar espacio» y carpetas conocidas, con rutas reales de Windows.
import { describe, expect, test } from 'bun:test';
import { compileQuery } from '@tessera/protocol';
import { RULES, cmdOf, knownId, ruleKind, ruleMatches, titleOf, type Target } from '../src/clean';

const rule = (id: string) => RULES.find(r => r.id === id)!;
function target(path: string, isDir = true): Target {
  const name = path.slice(path.lastIndexOf('\\') + 1), dot = name.lastIndexOf('.');
  return { name, path, isDir, ext: !isDir && dot > 0 ? name.slice(dot + 1).toLowerCase() : '' };
}
/** La consulta de la regla trae el elemento como candidato y su filtro lo acepta. */
function finds(id: string, path: string, isDir = true): boolean {
  const r = rule(id), t = target(path, isDir), q = compileQuery(r.q);
  const candidate = q.match({ ...t, size: 1e12, alloc: 1e12, mtime: 0, path: () => path });
  return candidate && ruleMatches(r, t);
}

describe('reglas de limpieza', () => {
  test('todas las consultas son válidas y los ids, únicos', () => {
    for (const r of RULES) expect(compileQuery(r.q).error).toBeUndefined();
    expect(new Set(RULES.map(r => r.id)).size).toBe(RULES.length);
  });

  test.each([
    ['packageCaches', 'C:\\Users\\ana\\AppData\\Local\\npm-cache', 'npm', 'npm cache clean --force'],
    ['packageCaches', 'C:\\Users\\ana\\AppData\\Local\\pnpm\\store', 'pnpm', 'pnpm store prune'],
    ['packageCaches', 'C:\\Users\\ana\\AppData\\Local\\Yarn\\Cache', 'Yarn', 'yarn cache clean'],
    ['packageCaches', 'C:\\Users\\ana\\.bun\\install\\cache', 'Bun', 'bun pm cache rm'],
    ['packageCaches', 'C:\\Users\\ana\\AppData\\Local\\pip\\cache', 'pip', 'pip cache purge'],
    ['packageCaches', 'C:\\Users\\ana\\AppData\\Local\\uv\\cache', 'uv', 'uv cache clean'],
    ['packageCaches', 'C:\\Users\\ana\\.nuget\\packages', 'NuGet', 'dotnet nuget locals all --clear'],
    ['packageCaches', 'C:\\Users\\ana\\AppData\\Local\\go-build', 'Go', 'go clean -cache'],
    ['browserCache', 'C:\\Users\\ana\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Cache', 'Chrome', undefined],
    ['browserCache', 'C:\\Users\\ana\\AppData\\Local\\Microsoft\\Edge\\User Data\\Profile 1\\Code Cache', 'Edge', undefined],
    ['browserCache', 'C:\\Users\\ana\\AppData\\Local\\Mozilla\\Firefox\\Profiles\\x1.default-release\\cache2', 'Firefox', undefined],
  ] as [string, string, string, string | undefined][])('%s: %s → %s', (id, path, name, cmd) => {
    expect(finds(id, path)).toBe(true);
    expect(titleOf(rule(id), target(path))).toEqual([`clean.${id}.title`, { name }]);
    expect(cmdOf(rule(id), target(path))).toBe(cmd);
  });

  test.each([
    ['crashDumps', 'C:\\Windows\\MEMORY.DMP', false],
    ['crashDumps', 'C:\\Windows\\Minidump', true],
    ['crashDumps', 'C:\\Windows\\LiveKernelReports', true],
    ['crashDumps', 'C:\\ProgramData\\Microsoft\\Windows\\WER\\ReportArchive', true],
    ['crashDumps', 'C:\\Users\\ana\\AppData\\Local\\CrashDumps', true],
    ['shaderCache', 'C:\\Users\\ana\\AppData\\Local\\D3DSCache', true],
    ['shaderCache', 'C:\\Users\\ana\\AppData\\Local\\NVIDIA\\DXCache', true],
    ['shaderCache', 'C:\\Users\\ana\\AppData\\Local\\AMD\\DxcCache', true],
    ['shaderCache', 'D:\\SteamLibrary\\steamapps\\shadercache', true],
    ['deliveryOptimization', 'C:\\Windows\\ServiceProfiles\\NetworkService\\AppData\\Local\\Microsoft\\Windows\\DeliveryOptimization', true],
    ['deliveryOptimization', 'C:\\Windows\\SoftwareDistribution\\DeliveryOptimization', true],
    ['packageCache', 'C:\\ProgramData\\Package Cache', true],
    ['driverStore', 'C:\\Windows\\System32\\DriverStore\\FileRepository', true],
    ['nodeModules', 'C:\\proyectos\\web\\node_modules', true],
    ['venv', 'C:\\proyectos\\api\\.venv', true],
    ['rustTarget', 'C:\\proyectos\\lamina\\target', true],
    ['temp', 'C:\\Users\\ana\\AppData\\Local\\Temp', true],
    ['recycleBin', 'C:\\$Recycle.Bin', true],
    ['systemFile', 'C:\\pagefile.sys', false],
    ['aiModels', 'C:\\modelos\\qwen.gguf', false],
    ['virtualDisks', 'C:\\Users\\ana\\AppData\\Local\\Docker\\wsl\\disk\\docker_data.vhdx', false],
    ['game', 'D:\\SteamLibrary\\steamapps\\common\\Cities Skylines II', true],
  ] as [string, string, boolean][])('%s encuentra %s', (id, path, isDir) => {
    expect(finds(id, path, isDir)).toBe(true);
  });

  test.each([
    ['packageCaches', 'C:\\proyectos\\web\\packages'],            // un monorepo, no la caché de NuGet
    ['packageCaches', 'C:\\Users\\ana\\AppData\\Local\\SomeApp\\cache'],
    ['browserCache', 'C:\\Users\\ana\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Cache\\Cache_Data'],
    ['browserCache', 'C:\\Users\\ana\\AppData\\Local\\OtraApp\\Cache'],
    ['shaderCache', 'C:\\Users\\ana\\AppData\\Local\\Temp\\ShaderCache'],
    ['nodeModules', 'C:\\proyectos\\web\\node_modules\\x\\node_modules'], // anidada: ya cuenta la de fuera
    ['nodeModules', 'C:\\Users\\ana\\AppData\\Roaming\\npm\\node_modules'], // de un programa instalado
    ['rustTarget', 'C:\\Program Files\\NVIDIA\\target'],
    ['packageCache', 'D:\\copias\\Package Cache'],
  ])('%s no confunde %s', (id, path) => {
    expect(finds(id, path)).toBe(false);
  });

  test('juegos: sugiere comprimirlos con compact si no lo están', () => {
    const p = 'D:\\SteamLibrary\\steamapps\\common\\Hades II';
    expect(cmdOf(rule('game'), { ...target(p), size: 8e9, alloc: 8e9 })).toBe(`compact /c /s /i /q /exe:lzx "${p}\\*"`);
    expect(cmdOf(rule('game'), { ...target(p), size: 8e9, alloc: 5e9 })).toBeUndefined(); // ya comprimido
  });

  test('OneDrive: la raíz de cada OneDrive, por espacio en disco y con su propia acción', () => {
    expect(finds('oneDrive', 'C:\\Users\\ana\\OneDrive')).toBe(true);
    expect(finds('oneDrive', 'C:\\Users\\ana\\OneDrive - Contoso')).toBe(true);
    expect(finds('oneDrive', 'C:\\Users\\ana\\OneDrive\\Documentos')).toBe(false);
    expect(finds('oneDrive', 'D:\\Copias\\OneDrive')).toBe(false);
    expect(rule('oneDrive')).toMatchObject({ useAlloc: true, action: 'freeUp', risk: 'ok' });
  });

  test('archivos y carpetas: cada regla sólo describe lo que busca', () => {
    expect(ruleKind(rule('crashDumps'))).toBe('any');
    expect(ruleKind(rule('nodeModules'))).toBe('dir');
    expect(ruleKind(rule('aiModels'))).toBe('file');
    expect(finds('crashDumps', 'D:\\copias\\MEMORY.DMP', false)).toBe(false);
    expect(ruleMatches(rule('nodeModules'), target('C:\\web\\node_modules', false))).toBe(false);
    expect(titleOf(rule('systemFile'), target('C:\\hiberfil.sys', false))).toEqual(['clean.hiberfil.title']);
    expect(titleOf(rule('systemFile'), target('C:\\pagefile.sys', false))).toEqual(['clean.pagefile.title']);
  });
});

describe('carpetas conocidas', () => {
  test.each([
    ['C:\\Windows', 'windows'],
    ['C:\\Windows\\System32', 'system32'],
    ['C:\\Windows\\SysWOW64', 'system32'],
    ['C:\\Windows\\Prefetch', 'prefetch'],
    ['C:\\Program Files', 'programFiles'],
    ['C:\\Program Files (x86)', 'programFiles'],
    ['C:\\Program Files\\WindowsApps', 'windowsApps'],
    ['C:\\ProgramData', 'programData'],
    ['C:\\Recovery', 'recovery'],
    ['C:\\Users', 'users'],
    ['C:\\Users\\ana\\AppData', 'appData'],
    ['C:\\Users\\ana\\AppData\\Local\\Packages', 'storePackages'],
    ['C:\\Users\\ana\\OneDrive', 'oneDrive'],
    ['C:\\Users\\ana\\OneDrive - Contoso', 'oneDrive'],
    ['C:\\Users\\ana\\Downloads', 'downloads'],
    ['D:\\SteamLibrary\\steamapps', 'steamapps'],
  ])('%s → %s', (path, id) => expect(knownId(path)).toBe(id));

  test.each(['C:\\Users\\ana\\Documents', 'C:\\Windows\\System32\\drivers', 'C:\\Juegos\\steamapps-copia'])('%s no es conocida', path => {
    expect(knownId(path)).toBeUndefined();
  });

  test('Windows instalado en otra unidad también se reconoce', () => expect(knownId('D:\\Windows')).toBe('windows'));
});
