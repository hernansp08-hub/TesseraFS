// Formato de cifras y textos según el idioma activo. Tamaños en base 1024 con el símbolo de cada idioma (GB, Go…).
import { i18n } from './i18n';

export const KB = 1024, MB = KB * 1024, GB = MB * 1024, TB = GB * 1024;

export const fmtB = (b: number) => i18n.bytes(b);
export const fmtN = (n: number) => i18n.number(n);
export const fmtP = (x: number) => i18n.percent(x);
export const fmtS = (ms: number) => i18n.seconds(ms);
export const fmtD = (t: number) => i18n.date(t);
export const ageText = (mtime: number, now = Date.now() / 1000) => i18n.relative(mtime, now);
export const esc = (s: unknown) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
