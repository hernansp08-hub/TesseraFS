// Manifiestos para gestores de paquetes de una versión ya publicada: winget (instalador NSIS), Scoop (zip de
// escritorio) y AUR (paquete -bin a partir del .deb y del CLI de Linux). Lee las sumas de SHA256SUMS.txt de la
// release en GitHub, así que se ejecuta después de publicar. No envía nada: deja los archivos en
// dist/manifiestos/vX.Y.Z/ para revisarlos y enviarlos a mano (ver docs/VERSIONES.md › Gestores de paquetes).
// Uso: bun scripts/manifests.ts [X.Y.Z]   (por defecto, la versión de package.json)
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dir, '..');
const REPO = 'hernansp08-hub/TesseraFS';
const version: string = process.argv[2] || JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const tag = `v${version}`, base = `https://github.com/${REPO}/releases/download/${tag}`;
const OUT = join(ROOT, 'dist', 'manifiestos', tag);
const die = (m: string): never => { console.error('✗ ' + m); process.exit(1); };

// Sumas publicadas (no las del equipo local: así coinciden con lo que se descarga)
const r = Bun.spawnSync(['gh', 'release', 'download', tag, '--repo', REPO, '--pattern', 'SHA256SUMS.txt', '--output', '-'], { cwd: ROOT });
if (r.exitCode !== 0) die(`No se pudo leer SHA256SUMS.txt de ${tag}: ${r.stderr.toString().trim()}`);
const sums = new Map(r.stdout.toString().trim().split('\n').map(l => { const [h, f] = l.trim().split(/\s+/); return [f, h] as [string, string]; }));
const sha = (f: string) => sums.get(f) ?? die(`${f} no está en SHA256SUMS.txt de ${tag}`);
const setup = `TesseraFS-${version}-instalador-win-x64.exe`, zip = `TesseraFS-${version}-escritorio-win-x64.zip`;
const deb = `TesseraFS-${version}-linux-amd64.deb`, cli = `TesseraFS-${version}-cli-linux-x64.tar.gz`;
const DESC = 'Disk space analyzer: a treemap of your disk, duplicates, scan history and explained cleanup suggestions. Everything stays local.';

// ---------- winget (microsoft/winget-pkgs: manifests/t/TesseraFS/TesseraFS/X.Y.Z/) ----------
const ID = 'TesseraFS.TesseraFS', W = join(OUT, 'winget', 'manifests', 't', 'TesseraFS', 'TesseraFS', version);
mkdirSync(W, { recursive: true });
const yml = (kind: string, body: string) =>
  `# yaml-language-server: $schema=https://aka.ms/winget-manifest.${kind}.1.9.0.schema.json\n\nPackageIdentifier: ${ID}\nPackageVersion: ${version}\n${body}ManifestType: ${kind}\nManifestVersion: 1.9.0\n`;
writeFileSync(join(W, `${ID}.yaml`), yml('version', 'DefaultLocale: en-US\n'));
writeFileSync(join(W, `${ID}.installer.yaml`), yml('installer', [
  'InstallerType: nullsoft', 'Scope: user', 'UpgradeBehavior: install', 'ProductCode: TesseraFS', `ReleaseDate: ${new Date().toISOString().slice(0, 10)}`,
  'Installers:', '- Architecture: x64', `  InstallerUrl: ${base}/${setup}`, `  InstallerSha256: ${sha(setup).toUpperCase()}`, '',
].join('\n')));
writeFileSync(join(W, `${ID}.locale.en-US.yaml`), yml('defaultLocale', [
  'PackageLocale: en-US', 'Publisher: TesseraFS', `PublisherUrl: https://github.com/${REPO}`, 'PackageName: TesseraFS',
  `PackageUrl: https://github.com/${REPO}`, 'License: MIT OR Apache-2.0', `LicenseUrl: https://github.com/${REPO}#licencia`,
  `ShortDescription: ${DESC}`, 'Moniker: tesserafs', 'Tags:', '- disk-usage', '- disk-space', '- treemap', '- duplicates', '- cleanup',
  `ReleaseNotesUrl: https://github.com/${REPO}/releases/tag/${tag}`, '',
].join('\n')));

// ---------- Scoop (bucket propio o ScoopInstaller/Extras) ----------
mkdirSync(join(OUT, 'scoop'), { recursive: true });
writeFileSync(join(OUT, 'scoop', 'tesserafs.json'), JSON.stringify({
  version, description: DESC, homepage: `https://github.com/${REPO}`, license: 'MIT|Apache-2.0',
  url: `${base}/${zip}`, hash: sha(zip), extract_dir: `TesseraFS-${version}-escritorio`,
  bin: 'tessera-cli.exe', shortcuts: [['tesserafs-desktop.exe', 'TesseraFS']],
  checkver: { github: `https://github.com/${REPO}` },
  autoupdate: { url: `https://github.com/${REPO}/releases/download/v$version/TesseraFS-$version-escritorio-win-x64.zip`, extract_dir: 'TesseraFS-$version-escritorio' },
}, null, 2) + '\n');

// ---------- AUR (tesserafs-bin) ----------
const A = join(OUT, 'aur', 'tesserafs-bin'); mkdirSync(A, { recursive: true });
const pkgbuild = `# Maintainer: hernansp08-hub <https://github.com/${REPO}>
pkgname=tesserafs-bin
pkgver=${version.replace(/-/g, '_')}
pkgrel=1
pkgdesc='${DESC.replace(/'/g, '')}'
arch=('x86_64')
url='https://github.com/${REPO}'
license=('MIT OR Apache-2.0')
depends=('webkit2gtk-4.1' 'gtk3' 'xdg-utils' 'glib2')
provides=('tesserafs')
conflicts=('tesserafs')
source=("${base}/${deb}" "${base}/${cli}")
sha256sums=('${sha(deb)}' '${sha(cli)}')
noextract=('${deb}')

package() {
  bsdtar -xOf '${deb}' 'data.tar.*' | bsdtar -xf - -C "$pkgdir"
  install -Dm755 "TesseraFS-${version}-cli/tessera-cli" "$pkgdir/usr/bin/tessera-cli"
  install -Dm644 "TesseraFS-${version}-cli/licencias/LICENSE-MIT" "$pkgdir/usr/share/licenses/$pkgname/LICENSE-MIT"
  install -Dm644 "TesseraFS-${version}-cli/licencias/LICENSE-APACHE" "$pkgdir/usr/share/licenses/$pkgname/LICENSE-APACHE"
}
`;
writeFileSync(join(A, 'PKGBUILD'), pkgbuild);
writeFileSync(join(A, '.SRCINFO'), [
  'pkgbase = tesserafs-bin', `\tpkgdesc = ${DESC.replace(/'/g, '')}`, `\tpkgver = ${version.replace(/-/g, '_')}`, '\tpkgrel = 1',
  `\turl = https://github.com/${REPO}`, '\tarch = x86_64', '\tlicense = MIT OR Apache-2.0',
  ...['webkit2gtk-4.1', 'gtk3', 'xdg-utils', 'glib2'].map(d => `\tdepends = ${d}`), '\tprovides = tesserafs', '\tconflicts = tesserafs',
  `\tnoextract = ${deb}`, `\tsource = ${base}/${deb}`, `\tsource = ${base}/${cli}`, `\tsha256sums = ${sha(deb)}`, `\tsha256sums = ${sha(cli)}`,
  '', 'pkgname = tesserafs-bin', '',
].join('\n'));

console.log(`✓ Manifiestos de ${tag} en ${OUT}`);
for (const p of ['winget', 'scoop/tesserafs.json', 'aur/tesserafs-bin/PKGBUILD']) console.log('  ' + p);
