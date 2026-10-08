// Publica una versión de TesseraFS en un solo paso:
//   1. calcula el número siguiente (SemVer),
//   2. lo escribe en todos los manifiestos (npm, Cargo, Tauri),
//   3. genera la entrada del CHANGELOG a partir de los commits convencionales,
//   4. hace el commit "chore(release): vX.Y.Z" y la etiqueta anotada vX.Y.Z.
// No sube nada: el push es decisión tuya (git push --follow-tags).
//
// Uso: bun run release <auto|patch|minor|major|pre|final|X.Y.Z> [--pre=beta] [--dry]
//   auto   elige según los commits: feat → minor, fix/perf → patch, cambio incompatible → major (minor mientras sea 0.x)
//   pre    siguiente prerrelease: 0.2.0-beta.1 → 0.2.0-beta.2
//   final  quita el sufijo de prerrelease: 0.2.0-beta.3 → 0.2.0
//   --pre=beta  con patch/minor/major crea una prerrelease: minor --pre=beta → 0.2.0-beta.1
//   --dry  muestra lo que haría sin tocar nada
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dir, '..');
const args = process.argv.slice(2);
const dry = args.includes('--dry');
const preArg = args.find(a => a.startsWith('--pre'));
const preId = preArg ? (preArg.split('=')[1] || 'beta') : '';
let kind = args.find(a => !a.startsWith('--')) || '';

const git = (...a: string[]) => {
  const r = Bun.spawnSync(['git', ...a], { cwd: ROOT });
  return { ok: r.exitCode === 0, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
};
const die = (m: string): never => { console.error('✗ ' + m); process.exit(1); };

// ---------- Commits desde la última versión ----------
const last = git('describe', '--tags', '--abbrev=0', '--match', 'v*');
const range = last.ok ? `${last.out}..HEAD` : 'HEAD';
const log = git('log', range, '--no-merges', '--pretty=format:%s%x1f%b%x1e');
interface C { type: string; scope: string; breaking: boolean; text: string }
const commits: C[] = (log.ok ? log.out : '').split('\x1e').map(s => s.trim()).filter(Boolean).flatMap(raw => {
  const [subject, body = ''] = raw.split('\x1f');
  const m = subject.match(/^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/);
  if (!m) return [{ type: 'other', scope: '', breaking: /BREAKING CHANGE/.test(body), text: subject }];
  if (m[1] === 'chore' && m[2] === 'release') return [];
  return [{ type: m[1], scope: m[2] || '', breaking: !!m[3] || /BREAKING CHANGE/.test(body), text: m[4] }];
});

// ---------- Versión siguiente ----------
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const rootPkgPath = join(ROOT, 'package.json');
const current: string = JSON.parse(readFileSync(rootPkgPath, 'utf8')).version || die('package.json raíz sin "version"');
const cm = current.match(SEMVER) || die('Versión actual no válida: ' + current);
let [maj, min, pat] = [+cm[1], +cm[2], +cm[3]];
const curPre = cm[4] || '';
if (kind === 'auto') {
  const breaking = commits.some(c => c.breaking), feat = commits.some(c => c.type === 'feat');
  kind = breaking ? (maj === 0 ? 'minor' : 'major') : feat ? 'minor' : 'patch';
  console.log(`auto → ${kind} (${commits.length} commits desde ${last.ok ? last.out : 'el inicio'})`);
}
let next: string;
if (SEMVER.test(kind)) next = kind;
else if (kind === 'pre') {
  if (!curPre) die('La versión actual no es una prerrelease: usa, por ejemplo, "minor --pre=beta"');
  const p = curPre.match(/^(.*?)(\d+)$/);
  next = `${maj}.${min}.${pat}-${p ? p[1] + (+p[2] + 1) : curPre + '.1'}`;
} else if (kind === 'final') {
  if (!curPre) die('La versión actual ya es final');
  next = `${maj}.${min}.${pat}`;
} else if (kind === 'major' || kind === 'minor' || kind === 'patch') {
  if (kind === 'major') { maj++; min = 0; pat = 0; } else if (kind === 'minor') { min++; pat = 0; } else pat++;
  next = `${maj}.${min}.${pat}` + (preId ? `-${preId}.1` : '');
} else die('Uso: bun run release <auto|patch|minor|major|pre|final|X.Y.Z> [--pre=beta] [--dry]');
if (git('tag', '--list', `v${next}`).out) die(`La etiqueta v${next} ya existe`);
console.log(`Versión: ${current} → ${next}`);

// ---------- Árbol de trabajo limpio ----------
if (!dry && git('status', '--porcelain').out) die('Hay cambios sin confirmar: haz commit o guárdalos antes de publicar una versión');

// ---------- Manifiestos ----------
const MANIFESTS = [
  'package.json', 'packages/protocol/package.json', 'packages/ui/package.json', 'packages/core-bun/package.json',
  'apps/portable/package.json', 'apps/desktop/package.json', 'apps/desktop/src-tauri/tauri.conf.json',
];
const edits: [string, string][] = [];
for (const rel of MANIFESTS) {
  const p = join(ROOT, rel), s = readFileSync(p, 'utf8');
  const t = s.replace(/("version"\s*:\s*")[^"]*(")/, `$1${next}$2`);
  if (t === s) die(`No encontré "version" en ${rel}`);
  edits.push([p, t]);
}
const cargoPath = join(ROOT, 'Cargo.toml'), cargo = readFileSync(cargoPath, 'utf8');
const cargoNext = cargo.replace(/(\[workspace\.package\][^[]*?\nversion\s*=\s*")[^"]+(")/, `$1${next}$2`);
if (cargoNext === cargo) die('No encontré version en [workspace.package] de Cargo.toml');
edits.push([cargoPath, cargoNext]);

// ---------- CHANGELOG ----------
const GROUPS: [string, (c: C) => boolean][] = [
  ['Cambios incompatibles', c => c.breaking],
  ['Añadido', c => !c.breaking && c.type === 'feat'],
  ['Corregido', c => !c.breaking && c.type === 'fix'],
  ['Rendimiento', c => !c.breaking && c.type === 'perf'],
  ['Cambiado', c => !c.breaking && (c.type === 'refactor' || c.type === 'style')],
];
const today = new Date().toISOString().slice(0, 10);
let section = '';
for (const [title, pick] of GROUPS) {
  const items = commits.filter(pick);
  if (items.length) section += `\n### ${title}\n` + items.map(c => `- ${c.scope ? `**${c.scope}:** ` : ''}${c.text}`).join('\n') + '\n';
}
const clPath = join(ROOT, 'CHANGELOG.md'), cl = readFileSync(clPath, 'utf8');
const UNREL = '## [Sin publicar]';
const i0 = cl.indexOf(UNREL); if (i0 < 0) die('CHANGELOG.md sin la sección "## [Sin publicar]"');
const i1 = cl.indexOf('\n## [', i0 + UNREL.length);
const manual = cl.slice(i0 + UNREL.length, i1 < 0 ? undefined : i1).trim();
const entry = `${UNREL}\n\n## [${next}] - ${today}\n${manual ? '\n' + manual + '\n' : ''}${section || '\n- Mantenimiento.\n'}`;
let clNext = cl.slice(0, i0) + entry + (i1 < 0 ? '' : cl.slice(i1));
clNext = clNext.replace(/^\[Sin publicar\]: .*$/m, `[Sin publicar]: ../../compare/v${next}...HEAD\n[${next}]: ../../compare/${last.ok ? last.out : 'v' + current}...v${next}`);
edits.push([clPath, clNext]);

if (dry) {
  console.log('\n--dry: no se ha modificado nada. Entrada del CHANGELOG:\n');
  console.log(entry);
  process.exit(0);
}
for (const [p, t] of edits) writeFileSync(p, t);
// Cargo.lock refleja la versión de los crates del workspace
const cu = Bun.spawnSync(['cargo', 'update', '--workspace', '--offline'], { cwd: ROOT });
if (cu.exitCode !== 0) console.warn('Aviso: no se pudo actualizar Cargo.lock (' + cu.stderr.toString().trim().split('\n').pop() + ')');

const add = git('add', '-A'); if (!add.ok) die(add.err);
const com = git('commit', '-m', `chore(release): v${next}`); if (!com.ok) die(com.err);
const tag = git('tag', '-a', `v${next}`, '-m', `TesseraFS ${next}`); if (!tag.ok) die(tag.err);
console.log(`✓ Commit y etiqueta v${next} creados.\nPara publicarla: git push --follow-tags`);
