// Descarga una sola vez las fuentes (licencia SIL OFL) para incrustarlas: la app no debe pedir nada a internet.
// Uso: bun packages/ui/scripts/fetch-fonts.ts
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

const URL_CSS = 'https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500..800&family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const dir = join(import.meta.dir, '..', 'fonts');
mkdirSync(dir, { recursive: true });
const cssText = await (await fetch(URL_CSS, { headers: { 'User-Agent': UA } })).text();
// Sólo los subconjuntos latin y latin-ext (español completo)
const blocks = [...cssText.matchAll(/\/\* (latin(?:-ext)?) \*\/\s*@font-face\s*\{([^}]*)\}/g)];
// Las fuentes variables llegan repetidas por peso con la misma URL: se agrupan en un rango de pesos
const byUrl = new Map<string, { fam: string; subset: string; body: string; weights: number[] }>();
for (const [, subset, body] of blocks) {
  const url = body.match(/url\((https:[^)]+)\)/)![1], fam = body.match(/font-family:\s*'([^']+)'/)![1];
  const w = body.match(/font-weight:\s*([\d ]+);/)![1].trim().split(/\s+/).map(Number);
  const e = byUrl.get(url); if (e) e.weights.push(...w); else byUrl.set(url, { fam, subset, body, weights: w });
}
let out = '/* Fuentes incrustadas: Bricolage Grotesque e IBM Plex (SIL Open Font License 1.1) */\n';
let i = 0;
for (const [url, e] of byUrl) {
  const file = `${e.fam.replace(/\s+/g, '')}-${e.subset}-${i++}.woff2`;
  writeFileSync(join(dir, file), new Uint8Array(await (await fetch(url)).arrayBuffer()));
  const lo = Math.min(...e.weights), hi = Math.max(...e.weights);
  out += `@font-face {${e.body.replace(/url\([^)]+\)/, `url(./${file})`).replace(/font-weight:\s*[\d ]+;/, `font-weight: ${lo === hi ? lo : lo + ' ' + hi};`)}}\n`;
}
writeFileSync(join(dir, 'fonts.css'), out);
console.log(`${i} archivos de fuente en ${dir}`);
