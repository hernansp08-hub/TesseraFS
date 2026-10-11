// Reglas de «Liberar espacio» y carpetas conocidas, con rutas reales de Windows.
import { describe, expect, test } from 'bun:test';
import { FLAG, compileQuery } from '@tessera/protocol';
import { LINUX_RULES, RULES, cmdOf, knownId, knownIdFor, ruleKind, ruleMatches, rulesFor, titleOf, type Target } from '../src/clean';

const rule = (id: string) => RULES.find(r => r.id === id)!;
function target(path: string, isDir = true, flags = 0): Target {
  const name = path.slice(path.lastIndexOf('\\') + 1), dot = name.lastIndexOf('.');
  return { name, path, isDir, ext: !isDir && dot > 0 ? name.slice(dot + 1).toLowerCase() : '', flags };
}
/** La consulta de la regla trae el elemento como candidato y su filtro lo acepta. */
function finds(id: string, path: string, isDir = true, flags = 0): boolean {
  const r = rule(id), t = target(path, isDir, flags), q = compileQuery(r.q);
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
    const cloud = (p: string) => finds('oneDrive', p, true, FLAG.DIR | FLAG.CLOUD);
    expect(cloud('C:\\Users\\ana\\OneDrive')).toBe(true);
    expect(cloud('C:\\Users\\ana\\OneDrive - Contoso')).toBe(true);
    expect(cloud('C:\\Users\\ana\\OneDrive\\Documentos')).toBe(false);
    expect(cloud('D:\\Copias\\OneDrive')).toBe(false);
    // Sin «Archivos a petición» no lleva la marca de la nube: todo está descargado y no hay nada que liberar
    expect(finds('oneDrive', 'C:\\Users\\ana\\OneDrive', true, FLAG.DIR)).toBe(false);
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

describe('Linux', () => {
  const lrule = (id: string) => LINUX_RULES.find(r => r.id === id)!;
  function ltarget(path: string, isDir = true): Target {
    const name = path.slice(path.lastIndexOf('/') + 1), dot = name.lastIndexOf('.');
    return { name, path, isDir, ext: !isDir && dot > 0 ? name.slice(dot + 1).toLowerCase() : '', flags: 0 };
  }
  function lfinds(id: string, path: string, isDir = true): boolean {
    const r = lrule(id), t = ltarget(path, isDir), q = compileQuery(r.q);
    return q.match({ ...t, size: 1e12, alloc: 1e12, mtime: 0, path: () => path }) && ruleMatches(r, t);
  }

  test('cada sistema tiene sus reglas; consultas válidas e ids únicos', () => {
    expect(rulesFor('windows')).toBe(RULES);
    expect(rulesFor('linux')).toBe(LINUX_RULES);
    for (const r of LINUX_RULES) expect(compileQuery(r.q).error).toBeUndefined();
    expect(new Set(LINUX_RULES.map(r => r.id)).size).toBe(LINUX_RULES.length);
  });

  test.each([
    ['rustTarget', '/home/ana/proyectos/lamina/target', true],
    ['nodeModules', '/home/ana/web/node_modules', true],
    ['venv', '/home/ana/api/.venv', true],
    ['userCache', '/home/ana/.cache', true],
    ['userCache', '/root/.cache', true],
    ['packageCaches', '/home/ana/.npm', true],
    ['packageCaches', '/home/ana/.bun/install/cache', true],
    ['packageCaches', '/home/ana/go/pkg/mod', true],
    ['systemPackages', '/var/cache/apt/archives', true],
    ['systemPackages', '/var/cache/pacman/pkg', true],
    ['journal', '/var/log/journal', true],
    ['coreDumps', '/var/lib/systemd/coredump', true],
    ['userTrash', '/home/ana/.local/share/Trash', true],
    ['shaderCache', '/home/ana/.local/share/Steam/steamapps/shadercache', true],
    ['vmImages', '/home/ana/.local/share/gnome-boxes/images/fedora.qcow2', false],
    ['containers', '/var/lib/docker', true],
    ['containers', '/home/ana/.local/share/containers', true],
    ['game', '/home/ana/.local/share/Steam/steamapps/common/Hades II', true],
    ['flatpak', '/var/lib/flatpak', true],
    ['snapRevisions', '/var/lib/snapd/snaps', true],
    ['timeshift', '/timeshift/snapshots', true],
    ['swapLinux', '/swap.img', false],
    ['swapLinux', '/swapfile', false],
  ] as [string, string, boolean][])('%s encuentra %s', (id, path, isDir) => {
    expect(lfinds(id, path, isDir)).toBe(true);
  });

  test.each([
    ['nodeModules', '/usr/lib/node_modules'],                                   // de un programa instalado
    ['nodeModules', '/home/ana/.local/share/containers/storage/x/node_modules'], // capa de un contenedor
    ['nodeModules', '/home/ana/web/node_modules/x/node_modules'],               // anidada
    ['rustTarget', '/opt/app/target'],
    ['userCache', '/home/ana/proyecto/.cache'],
    ['packageCaches', '/home/ana/.cache/pip'],                                   // ya la cubre ~/.cache
    ['systemPackages', '/home/ana/archives'],
    ['journal', '/home/ana/journal'],
    ['userTrash', '/home/ana/Trash'],
    ['containers', '/home/ana/docker'],
    ['timeshift', '/home/ana/snapshots'],
  ])('%s no confunde %s', (id, path) => {
    expect(lfinds(id, path)).toBe(false);
  });

  test('descargas: la consulta encuentra instaladores y comprimidos en Descargas, en cualquier idioma', () => {
    const q = compileQuery(lrule('downloads').q);
    const m = (path: string) => { const t = ltarget(path, false); return q.match({ ...t, size: 5e8, alloc: 5e8, mtime: 0, path: () => path }); };
    expect(m('/home/ana/Descargas/ubuntu.iso')).toBe(true);
    expect(m('/home/ana/Downloads/app.AppImage')).toBe(true);
    expect(m('/home/ana/Téléchargements/jeu.zip')).toBe(true);
    expect(m('/home/ana/Documentos/ubuntu.iso')).toBe(false);
  });

  test('las órdenes y los títulos dependen de lo encontrado', () => {
    expect(cmdOf(lrule('systemPackages'), ltarget('/var/cache/apt/archives'))).toBe('sudo apt clean');
    expect(cmdOf(lrule('systemPackages'), ltarget('/var/cache/dnf'))).toBe('sudo dnf clean all');
    expect(titleOf(lrule('systemPackages'), ltarget('/var/cache/apt/archives'))).toEqual(['clean.systemPackages.title', { name: 'APT' }]);
    expect(cmdOf(lrule('containers'), ltarget('/home/ana/.local/share/containers'))).toBe('podman system prune -a');
    expect(titleOf(lrule('containers'), ltarget('/var/lib/docker'))).toEqual(['clean.containers.title', { name: 'Docker' }]);
    expect(cmdOf(lrule('game'), ltarget('/home/ana/.local/share/Steam/steamapps/common/Hades II'))).toBeUndefined(); // compact es de Windows
  });

  test.each([
    ['/usr', 'usr'], ['/usr/lib/modules', 'kernelModules'], ['/var/log', 'varLog'], ['/var/lib', 'varLib'], ['/boot', 'boot'],
    ['/tmp', 'tmp'], ['/var/tmp', 'tmp'], ['/home', 'home'], ['/home/ana/.local/share', 'localShare'], ['/root/.config', 'dotConfig'],
    ['/usr/share/ollama', 'ollama'], ['/home/ana/.ollama/models', 'ollama'], ['/home/ana/Descargas', 'downloads'],
    ['/home/ana/.local/share/Steam/steamapps', 'steamapps'],
  ])('carpeta conocida de Linux: %s → %s', (path, id) => expect(knownIdFor(path, 'linux')).toBe(id));

  test('las rutas de Windows no son conocidas en Linux, ni al revés', () => {
    expect(knownIdFor('C:\\Windows', 'linux')).toBeUndefined();
    expect(knownIdFor('/usr', 'windows')).toBeUndefined();
  });
});
