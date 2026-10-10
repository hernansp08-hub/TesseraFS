// Idioma de la interfaz: instancia activa, traducción del HTML estático y mensajes con código de los motores.
// Diseño completo en docs/tecnica/i18n.md.
import type { EngineMessage } from '@tessera/protocol';
import { I18n, LOCALES, PSEUDO, negotiate, type MessageKey, type Params } from '@tessera/i18n';

export { LOCALES, PSEUDO, type MessageKey };
const STORE = 'tesserafs-locale';

/**
 * Preferencia guardada: 'auto' (idioma del sistema), un código de LOCALES o el pseudoidioma.
 * El enlace manda sobre lo guardado sin sobrescribirlo: #pseudo, #lang=fr (útil para capturas y pruebas).
 */
export function storedPreference(): string {
  if (/(^|[#,+])pseudo\b/i.test(location.hash)) return PSEUDO;
  const forced = location.hash.match(/(?:^#|[,+])lang=([\w-]+)/i);
  if (forced) return forced[1].toLowerCase() === PSEUDO.toLowerCase() ? PSEUDO : negotiate([forced[1]]);
  try { return localStorage.getItem(STORE) || 'auto'; } catch { return 'auto'; }
}
export const systemLocale = () => negotiate(navigator.languages?.length ? navigator.languages : [navigator.language || 'en']);
const resolve = (pref: string) => pref === PSEUDO ? PSEUDO : pref === 'auto' || !LOCALES.some(l => l.code === pref) ? systemLocale() : pref;

let pref = storedPreference();
const warnMissing = (k: string, l: string) => console.warn(`[i18n] falta «${k}» en ${l}`);
export let i18n = new I18n(resolve(pref));
i18n.onMissing = warnMissing;

export const preference = () => pref;
export const t = (key: MessageKey, params?: Params) => i18n.t(key, params);
/** Para claves que se construyen en tiempo de ejecución (cat.<id>, phase.<fase>…). Las cubre la prueba de catálogos. */
export const tk = (key: string, params?: Params) => i18n.t(key, params);
export const html = (key: MessageKey, params?: Params) => i18n.html(key, params);

/** Texto de un mensaje de los motores. Sin traducción conocida, el texto en inglés que trae el propio mensaje. */
export function msgText(m: unknown): string {
  if (m && typeof m === 'object' && typeof (m as EngineMessage).code === 'string') {
    const em = m as EngineMessage, key = 'engine.' + em.code;
    if (i18n.has(key)) return i18n.t(key, em.params);
    return em.message || em.code;
  }
  if (m instanceof Error) return m.message;
  return String(m);
}

/**
 * Traduce el HTML estático:
 *   data-i18n="clave"              texto
 *   data-i18n-html="clave"         HTML seguro (b, code, kbd, br)
 *   data-i18n-title / -aria / -placeholder="clave"
 */
export function translateDom(root: ParentNode = document) {
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n]')) el.textContent = tk(el.dataset.i18n!);
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n-html]')) el.innerHTML = i18n.html(el.dataset.i18nHtml!);
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n-title]')) el.title = tk(el.dataset.i18nTitle!);
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n-aria]')) el.setAttribute('aria-label', tk(el.dataset.i18nAria!));
  for (const el of root.querySelectorAll<HTMLInputElement>('[data-i18n-placeholder]')) el.placeholder = tk(el.dataset.i18nPlaceholder!);
  const doc = document.documentElement; doc.lang = i18n.locale === PSEUDO ? 'en' : i18n.locale; doc.dir = i18n.dir;
}

const listeners: (() => void)[] = [];
export const onLocaleChange = (fn: () => void) => { listeners.push(fn); };
/** Cambia el idioma en caliente y lo recuerda. */
export function setPreference(p: string) {
  pref = p;
  try { if (p === PSEUDO) localStorage.removeItem(STORE); else localStorage.setItem(STORE, p); } catch { }
  i18n = new I18n(resolve(p)); i18n.onMissing = warnMissing;
  translateDom();
  for (const fn of listeners) fn();
}
