// Estado de las traducciones: por idioma, claves que faltan, que sobran y que siguen idénticas al inglés.
// Uso: bun run i18n:check [--strict]   (--strict sale con error si falta o sobra alguna clave)
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const dir = join(import.meta.dir, '..', 'packages', 'i18n', 'locales');
const load = (f: string): Record<string, string> => JSON.parse(readFileSync(join(dir, f), 'utf8'));
const en = load('en.json'), keys = Object.keys(en);
const context = load('_context.json');
// Textos que suelen coincidir con el inglés sin ser un olvido (siglas, nombres, símbolos)
const SAME_OK = /^(%|MFT|Demo|Audio|Code|Normal|Guide|Portable|Extension|Composition|Options \(.*|Esc|Ctrl K|Name)$/;

let problems = 0;
console.log(`Base: en · ${keys.length} claves · ${Object.keys(context).length - 1} notas para traductores\n`);
console.log('Idioma'.padEnd(8), 'Completo'.padStart(9), 'Faltan'.padStart(7), 'Sobran'.padStart(7), 'Igual al inglés'.padStart(16));
for (const f of readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'en.json' && !f.startsWith('_')).sort()) {
  const code = f.replace(/\.json$/, ''), cat = load(f);
  const missing = keys.filter(k => !(k in cat)), extra = Object.keys(cat).filter(k => !(k in en));
  const same = keys.filter(k => cat[k] === en[k] && !SAME_OK.test(en[k]) && !/^[^a-z]*$/i.test(en[k]));
  const pct = ((keys.length - missing.length) / keys.length * 100).toFixed(1) + ' %';
  console.log(code.padEnd(8), pct.padStart(9), String(missing.length).padStart(7), String(extra.length).padStart(7), String(same.length).padStart(16));
  for (const k of missing) console.log(`   falta   ${k}`);
  for (const k of extra) console.log(`   sobra   ${k}`);
  if (process.argv.includes('--same')) for (const k of same) console.log(`   igual   ${k}: ${en[k]}`);
  problems += missing.length + extra.length;
}
const stale = Object.keys(context).filter(k => k !== '_' && !(k in en));
for (const k of stale) console.log(`\n_context.json: nota de una clave que ya no existe: ${k}`);
console.log('\n--same muestra los textos idénticos al inglés.');
if (process.argv.includes('--strict') && (problems || stale.length)) process.exit(1);
