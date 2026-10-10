// README.txt multilingüe de los zips: un bloque por idioma (el inglés primero), compuesto con las claves readme.*.
// Lo usan scripts/package.ts (escritorio) y apps/portable/pack.ts (portable).
import { BASE, I18n, LOCALES } from './index';

export type Edition = 'desktop' | 'portable';

/** Ajusta un párrafo a `width` columnas con sangría. */
function wrap(text: string, indent = '  ', width = 92): string[] {
  const out: string[] = []; let line = '';
  for (const w of text.split(/ +/)) {
    if (line && indent.length + line.length + 1 + w.length > width) { out.push(indent + line); line = w; }
    else line = line ? line + ' ' + w : w;
  }
  if (line) out.push(indent + line);
  return out;
}

function section(i: I18n, edition: Edition, version: string): string[] {
  const t = (k: string, p?: Record<string, string>) => i.t(k, p);
  const name = LOCALES.find(l => l.code === i.locale)!.name;
  const title = `${t('readme.title', { version })} · ${t(edition === 'desktop' ? 'app.edition.desktop' : 'app.edition.portable')}`;
  const paras = edition === 'desktop'
    ? ['readme.desktop.open', 'readme.desktop.smartscreen', 'readme.desktop.webview', 'readme.fastMode', 'readme.cli', 'readme.privacy']
    : ['readme.portable.open', 'readme.portable.signed', 'readme.portable.vbs', 'readme.fastMode', 'readme.links', 'readme.portable.privacy', 'readme.privacy'];
  const lines = [`[${name}]`, title, '='.repeat(Math.min(92, title.length)), ''];
  for (const k of paras) lines.push(...wrap(t(k)), '');
  if (edition === 'portable') {
    lines.push(...wrap(t('readme.options')));
    for (const [flag, k] of [['--debug', 'readme.opt.debug'], ['--no-window', 'readme.opt.noWindow'], ['--threads=N', 'readme.opt.threads']])
      lines.push(`    ${flag.padEnd(13)}${t(k)}`);
    lines.push('');
  }
  return lines;
}

/** Texto completo con saltos CRLF y BOM, para que el Bloc de notas de cualquier Windows lo muestre bien. */
export function readmeText(edition: Edition, version: string): string {
  const order = [BASE, ...LOCALES.map(l => l.code).filter(c => c !== BASE)];
  const lines = order.flatMap(code => section(new I18n(code), edition, version));
  // Los espacios duros del francés se conservan: wrap() no corta por ellos
  return '﻿' + lines.join('\r\n').trimEnd() + '\r\n';
}
