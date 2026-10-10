// Errores de los motores como Error de JS que además lleva el EngineMessage (code, params, message):
// la interfaz los traduce con msgText y el texto en inglés queda como respaldo.
import type { EngineMessage } from '@tessera/protocol';

export type EngineFailure = Error & EngineMessage;

export function isEngineMessage(x: unknown): x is EngineMessage {
  return !!x && typeof x === 'object' && typeof (x as EngineMessage).code === 'string';
}
export function engineFailure(x: unknown): EngineFailure | Error {
  if (x instanceof Error) return x;
  if (isEngineMessage(x)) return Object.assign(new Error(x.message || x.code), { code: x.code, params: x.params, message: x.message || x.code });
  return new Error(typeof x === 'string' ? x : JSON.stringify(x));
}
export const fail = (code: string, message: string, params?: EngineMessage['params']) => engineFailure({ code, params, message });
