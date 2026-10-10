// Mensajes para el usuario (i18n): el motor nunca envía frases, sólo códigos + parámetros + un texto
// de reserva en inglés. La interfaz los traduce con la clave `engine.<code>`. Ver docs/tecnica/i18n.md.
import type { EngineMessage } from '../../protocol/src/index.ts';

export type { EngineMessage };
export type MessageParams = Record<string, string | number>;

const num = (v: string | number | undefined) => typeof v === 'number' ? v.toLocaleString('en-US') : String(v ?? '?');
const count = (v: string | number | undefined, one: string, other: string) => `${num(v)} ${v === 1 ? one : other}`;
const eg = (p: MessageParams) => p.sample ? ` (e.g. ${p.sample})` : '';

/** Textos de reserva en inglés, uno por código del contrato (también para los registros). */
const EN = {
  'scan.mftNeedsAdmin': () => 'The MFT engine needs administrator rights; the folder walk was used instead',
  'scan.mftUnsupportedFs': (p: MessageParams) => `The MFT engine only works on local NTFS volumes (this one is ${p.fs}); the folder walk was used instead`,
  'scan.mftNetworkPath': () => 'The MFT engine is not available on network paths; the folder walk was used instead',
  'scan.mftFailed': (p: MessageParams) => `The MFT could not be read (${p.error}); the folder walk was used instead`,
  'scan.mftFragmented': () => 'The MFT is heavily fragmented: part of it may be missing',
  'scan.mftBadRecords': (p: MessageParams) => `${count(p.count, 'MFT record', 'MFT records')} with invalid fixups ${p.count === 1 ? 'was' : 'were'} skipped`,
  'scan.mftOrphans': (p: MessageParams) => `${count(p.count, 'entry', 'entries')} without a valid parent folder ${p.count === 1 ? 'is' : 'are'} not shown`,
  'scan.accessDenied': (p: MessageParams) => `${count(p.count, 'folder', 'folders')} could not be read (access denied); their contents are not counted${eg(p)}`,
  'scan.readErrors': (p: MessageParams) => `${count(p.count, 'folder', 'folders')} could not be read because of errors; their contents are not counted${eg(p)}`,
  'scan.demoData': () => 'Demo data: nothing was read from your disk',
  'error.invalidPath': (p: MessageParams) => `Invalid path (it must be absolute): ${p.path}`,
  'error.notFolder': (p: MessageParams) => `Not a folder: ${p.path}`,
  'error.cannotOpen': (p: MessageParams) => `Cannot open ${p.path}: ${p.error}`,
  'error.scanBusy': () => 'A scan is already in progress',
  'error.noScan': () => 'Nothing has been scanned yet',
  'error.invalidNode': (p: MessageParams) => `Unknown node id: ${p.id}`,
  'error.cancelled': () => 'Scan cancelled',
  'error.unsupportedPlatform': () => 'This engine only runs on Windows',
  'error.internal': (p: MessageParams) => `Internal error: ${p.error}`,
  'action.trashed': () => 'Moved to the Recycle Bin',
  'action.trashRoot': () => 'The scanned folder itself cannot be sent to the Recycle Bin',
  'action.trashNotMoved': () => 'Windows did not move the item to the Recycle Bin',
  'action.cancelled': () => 'The operation was cancelled',
  'action.failed': (p: MessageParams) => `The operation failed: ${p.error}`,
  'action.unknown': (p: MessageParams) => `Unknown action: ${p.kind}`,
  'elevation.failed': (p: MessageParams) => `Could not relaunch as administrator: ${p.error}`,
} satisfies Record<string, (p: MessageParams) => string>;

export type MessageCode = keyof typeof EN;
export const MESSAGE_CODES = Object.keys(EN) as MessageCode[];

/** Crea un EngineMessage con su texto de reserva en inglés. */
export function msg(code: MessageCode, params?: MessageParams): EngineMessage {
  const p = params && Object.keys(params).length ? params : undefined;
  return p ? { code, params: p, message: EN[code](p) } : { code, message: EN[code]({}) };
}

/** Error que llega a la interfaz: lleva su EngineMessage (el `message` de Error es el texto en inglés). */
export class EngineError extends Error {
  constructor(readonly msg: EngineMessage) {
    super(msg.message);
    this.name = 'EngineError';
  }
  get code() { return this.msg.code; }
}

export const engineError = (code: MessageCode, params?: MessageParams) => new EngineError(msg(code, params));

export function isEngineMessage(x: unknown): x is EngineMessage {
  if (!x || typeof x !== 'object') return false;
  const m = x as Record<string, unknown>;
  if (typeof m.code !== 'string' || typeof m.message !== 'string') return false;
  if (m.params === undefined) return true;
  if (!m.params || typeof m.params !== 'object' || Array.isArray(m.params)) return false;
  return Object.values(m.params).every(v => typeof v === 'string' || typeof v === 'number');
}

/** Texto técnico (en inglés si lo generó el motor) de cualquier fallo, para el parámetro `error`. */
export function errorText(e: unknown): string {
  if (e instanceof EngineError) return e.msg.message;
  if (e instanceof Error) return e.message || e.name;
  return String(e);
}

/** Cualquier fallo → EngineMessage. Lo que no es un EngineError se envuelve en `error.internal`. */
export function toEngineMessage(e: unknown): EngineMessage {
  if (e instanceof EngineError) return e.msg;
  if (isEngineMessage(e)) return e;
  return msg('error.internal', { error: errorText(e) });
}

/** Estado HTTP para un código de error: 400 entrada no válida, 404 nodo desconocido, 409 estado, 500 interno. */
export function httpStatus(code: string): number {
  switch (code) {
    case 'error.invalidPath': case 'error.notFolder': case 'error.cannotOpen': case 'action.unknown': return 400;
    case 'error.invalidNode': return 404;
    case 'error.noScan': case 'error.scanBusy': case 'error.cancelled': return 409;
    default: return 500;
  }
}

/** Respuesta HTTP de error: estado 4xx/5xx con el EngineMessage como cuerpo JSON. */
export function errorResponse(e: unknown, status?: number): Response {
  const m = toEngineMessage(e);
  return new Response(JSON.stringify(m), {
    status: status ?? httpStatus(m.code),
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
