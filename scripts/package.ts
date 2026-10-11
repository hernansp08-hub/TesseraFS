// Empaqueta la versión actual para el sistema donde se ejecuta y, con --publish, crea la release en GitHub.
// Windows:
//   dist/release/vX.Y.Z/TesseraFS-X.Y.Z-escritorio-win-x64.zip   tesserafs-desktop.exe + tessera-cli.exe + README multilingüe + licencias
//   dist/release/vX.Y.Z/TesseraFS-X.Y.Z-portable-win-x64.zip     carpeta portable (bun.exe firmado + tesserafs.js) + licencias
// Linux (x86_64):
//   dist/release/vX.Y.Z/TesseraFS-X.Y.Z-linux-x86_64.AppImage    la app de escritorio, sin instalar
//   dist/release/vX.Y.Z/TesseraFS-X.Y.Z-linux-amd64.deb          paquete para Debian/Ubuntu
//   dist/release/vX.Y.Z/TesseraFS-X.Y.Z-cli-linux-x64.tar.gz     tessera-cli + licencias
// Y en ambos: SHA256SUMS.txt y NOTAS.md (scripts/publish.ts, que también junta los de los dos sistemas en CI).
// Uso: bun run package [--skip-build] [--publish]
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { readmeText } from '../packages/i18n/src/readme';
import { publishRelease, sumsAndNotes } from './publish';

const ROOT = join(import.meta.dir, '..');
const args = process.argv.slice(2);
const skipBuild = args.includes('--skip-build'), publish = args.includes('--publish');
const version: string = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const tag = `v${version}`;
const OUT = join(ROOT, 'dist', 'release', tag);
const LINUX = process.platform === 'linux';
const TARGET = LINUX ? 'x86_64-unknown-linux-gnu' : 'x86_64-pc-windows-msvc';
// bsdtar: el de Windows crea .zip con -a; en Linux, el tar del sistema crea .tar.gz
const TAR = LINUX ? 'tar' : 'C:\\Windows\\System32\\tar.exe';

const die = (m: string): never => { console.error('✗ ' + m); process.exit(1); };
function run(cmd: string[], cwd = ROOT) {
  console.log(`$ ${cmd.join(' ')}`);
  const r = Bun.spawnSync(cmd, { cwd, stdout: 'inherit', stderr: 'inherit' });
  if (r.exitCode !== 0) die(`Falló: ${cmd.join(' ')}`);
}
const out = (cmd: string[]) => Bun.spawnSync(cmd, { cwd: ROOT }).stdout.toString().trim();

// ---------- 1. Compilar ----------
if (!skipBuild) {
  run(['bun', 'packages/ui/build.ts']);
  // En Linux, Tauri genera también los paquetes (AppImage y .deb); en Windows sólo el exe
  run(['bunx', 'tauri', 'build', ...(LINUX ? ['--bundles', 'appimage,deb'] : ['--no-bundle'])], join(ROOT, 'apps', 'desktop'));
  run(['cargo', 'build', '--release', '-p', 'tessera-cli']);
  if (!LINUX) run(['bun', 'apps/portable/pack.ts']);
}

// ---------- 2. Avisos de terceros ----------
function rustNotices(pkg: string, binary: string): string {
  const meta = JSON.parse(out(['cargo', 'metadata', '--format-version', '1', '--filter-platform', TARGET, '--locked']));
  const members = new Set<string>(meta.workspace_members);
  const nodes = new Map<string, { deps: { pkg: string; dep_kinds: { kind: string | null }[] }[] }>(meta.resolve.nodes.map((n: any) => [n.id, n]));
  const root = meta.packages.find((p: any) => p.name === pkg).id;
  // Sólo lo que acaba dentro del ejecutable: dependencias normales alcanzables desde él
  const seen = new Set<string>([root]); const stack = [root];
  while (stack.length) for (const d of nodes.get(stack.pop()!)!.deps)
    if (d.dep_kinds.some(k => k.kind === null) && !seen.has(d.pkg)) { seen.add(d.pkg); stack.push(d.pkg); }
  const rows = meta.packages.filter((p: any) => seen.has(p.id) && !members.has(p.id))
    .sort((a: any, b: any) => a.name.localeCompare(b.name))
    .map((p: any) => `${p.name} ${p.version} — ${p.license || 'ver repositorio'} — ${p.repository || ''}`.trim());
  return `Bibliotecas de Rust incluidas en ${binary} (${rows.length}):\n\n${rows.join('\n')}\n`;
}
const fontsNotice = 'Fuentes incrustadas en la interfaz: Bricolage Grotesque e IBM Plex Sans/Mono,\n'
  + 'SIL Open Font License 1.1. Textos completos en la carpeta licencias/.\n';
const bunNotice = 'bun.exe es el runtime de Bun (https://bun.com), copiado sin modificar y firmado por su editor.\n'
  + 'Bun se distribuye bajo licencia MIT e incluye componentes de terceros, algunos bajo LGPL (como\n'
  + 'JavaScriptCore de WebKit), enlazados estáticamente. Licencias y avisos: https://bun.com/docs/project/license\n'
  + 'Código fuente: https://github.com/oven-sh/bun y https://github.com/oven-sh/WebKit\n';

function addLicenses(dir: string, extra: string) {
  const lic = join(dir, 'licencias'); mkdirSync(lic, { recursive: true });
  for (const f of ['LICENSE-MIT', 'LICENSE-APACHE']) cpSync(join(ROOT, f), join(lic, f));
  const fonts = join(ROOT, 'packages', 'ui', 'fonts', 'licencias');
  for (const f of readdirSync(fonts)) cpSync(join(fonts, f), join(lic, f));
  writeFileSync(join(dir, 'LICENCIAS-TERCEROS.txt'),
    `TesseraFS ${version} se distribuye bajo licencia MIT o Apache-2.0, a tu elección (ver licencias/).\n\n${fontsNotice}\n${extra}`);
}

// ---------- 3. Preparar los paquetes ----------
rmSync(OUT, { recursive: true, force: true }); mkdirSync(OUT, { recursive: true });
const stage = join(OUT, 'stage'); mkdirSync(stage);

if (LINUX) {
  // Paquetes de Tauri: target/release/bundle/{appimage,deb}/TesseraFS_X.Y.Z_amd64.*
  const bundle = (kind: string, ext: string) => {
    const d = join(ROOT, 'target', 'release', 'bundle', kind);
    const f = existsSync(d) ? readdirSync(d).find(n => n.endsWith(ext) && n.includes(version)) : undefined;
    return f ? join(d, f) : die(`No existe el paquete ${ext} de ${version} en ${d}`);
  };
  cpSync(bundle('appimage', '.AppImage'), join(OUT, `TesseraFS-${version}-linux-x86_64.AppImage`));
  cpSync(bundle('deb', '.deb'), join(OUT, `TesseraFS-${version}-linux-amd64.deb`));
  const cli = join(ROOT, 'target', 'release', 'tessera-cli');
  if (!existsSync(cli)) die('No existe target/release/tessera-cli');
  const cliName = `TesseraFS-${version}-cli`, cliDir = join(stage, cliName);
  mkdirSync(cliDir); cpSync(cli, join(cliDir, 'tessera-cli'));
  addLicenses(cliDir, rustNotices('tessera-cli', 'tessera-cli'));
  run([TAR, '-czf', join(OUT, `${cliName}-linux-x64.tar.gz`), '-C', stage, cliName]);
} else {
  const exe = join(ROOT, 'target', 'release', 'tesserafs-desktop.exe');
  const cli = join(ROOT, 'target', 'release', 'tessera-cli.exe');
  const portable = join(ROOT, 'apps', 'portable', 'dist', 'TesseraFS-portable');
  if (!existsSync(exe)) die('No existe target/release/tesserafs-desktop.exe');
  if (!existsSync(cli)) die('No existe target/release/tessera-cli.exe');
  if (!existsSync(join(portable, 'tesserafs.js'))) die('No existe la carpeta portable');

  const deskName = `TesseraFS-${version}-escritorio`, deskDir = join(stage, deskName);
  mkdirSync(deskDir); cpSync(exe, join(deskDir, 'tesserafs-desktop.exe')); cpSync(cli, join(deskDir, 'tessera-cli.exe'));
  // README.txt en todos los idiomas de la interfaz (claves readme.* de packages/i18n)
  writeFileSync(join(deskDir, 'README.txt'), readmeText('desktop', version));
  addLicenses(deskDir, rustNotices('tesserafs-desktop', 'tesserafs-desktop.exe'));

  const portName = `TesseraFS-${version}-portable`, portDir = join(stage, portName);
  cpSync(portable, portDir, { recursive: true });
  addLicenses(portDir, bunNotice);

  for (const [name, label] of [[deskName, 'escritorio'], [portName, 'portable']])
    run([TAR, '-a', '-c', '-f', join(OUT, `TesseraFS-${version}-${label}-win-x64.zip`), '-C', stage, name]);
}
rmSync(stage, { recursive: true, force: true });

// ---------- 4. Sumas, notas y publicación ----------
const files = sumsAndNotes(OUT, version);
if (publish) publishRelease(OUT, version, files);
