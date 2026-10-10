// Contrato i18n del motor: códigos + parámetros + texto de reserva en inglés (docs/tecnica/i18n.md).
import { expect, test } from 'bun:test';
import { walkWarnings } from '../src/engine.ts';
import {
  EngineError, MESSAGE_CODES, engineError, errorResponse, httpStatus, isEngineMessage, msg, toEngineMessage,
} from '../src/messages.ts';

// La tabla de docs/tecnica/i18n.md («Mensajes de los motores»)
const CONTRACT = [
  'scan.mftNeedsAdmin', 'scan.mftUnsupportedFs', 'scan.mftNetworkPath', 'scan.mftFailed', 'scan.mftFragmented',
  'scan.mftBadRecords', 'scan.mftOrphans', 'scan.accessDenied', 'scan.readErrors', 'scan.demoData',
  'dup.readErrors',
  'error.invalidPath', 'error.notFolder', 'error.cannotOpen', 'error.scanBusy', 'error.dupBusy', 'error.noScan', 'error.invalidNode',
  'error.cancelled', 'error.unsupportedPlatform', 'error.internal',
  'action.trashed', 'action.trashRoot', 'action.trashNotMoved', 'action.cancelled', 'action.failed', 'action.unknown',
  'elevation.failed',
  'history.notFound', 'history.otherRoot', 'history.saveFailed', 'history.readFailed',
  'export.invalidName', 'export.failed', 'export.notFound',
];

test('messages: exactamente los códigos del contrato, con texto en inglés sin marcadores sueltos', () => {
  expect(([...MESSAGE_CODES] as string[]).sort()).toEqual([...CONTRACT].sort());
  const p = { fs: 'FAT32', error: 'boom', count: 2, path: 'C:\\x', id: 7, kind: 'zap', name: 'r.html' };
  for (const c of MESSAGE_CODES) {
    const m = msg(c, p);
    expect(isEngineMessage(m)).toBe(true);
    expect(m.message).not.toMatch(/undefined|\{|[áéíóúñ¿¡]/);
  }
});

test('messages: forma del objeto y plurales en inglés', () => {
  expect(msg('scan.mftNeedsAdmin')).toEqual({ code: 'scan.mftNeedsAdmin', message: 'The MFT engine needs administrator rights; the folder walk was used instead' });
  expect('params' in msg('error.noScan', {})).toBe(false);
  expect(msg('scan.mftUnsupportedFs', { fs: 'FAT32' })).toEqual({
    code: 'scan.mftUnsupportedFs', params: { fs: 'FAT32' },
    message: 'The MFT engine only works on local NTFS volumes (this one is FAT32); the folder walk was used instead',
  });
  expect(msg('scan.mftBadRecords', { count: 1 }).message).toBe('1 MFT record with invalid fixups was skipped');
  expect(msg('scan.mftOrphans', { count: 1536 }).message).toBe('1,536 entries without a valid parent folder are not shown');
  expect(msg('dup.readErrors', { count: 1 }).message).toBe("1 file couldn't be read and was left out");
  expect(msg('dup.readErrors', { count: 3 }).message).toBe("3 files couldn't be read and were left out");
  expect(msg('history.otherRoot', { path: 'D:\\' })).toEqual({
    code: 'history.otherRoot', params: { path: 'D:\\' }, message: 'That snapshot is of another folder (D:\\)',
  });
  expect(msg('export.invalidName', { name: 'a/b' }).message).toBe('Invalid file name: a/b');
});

test('walkWarnings: sólo dos recuentos (con rutas de muestra), nunca una línea por carpeta', () => {
  expect(walkWarnings({ denied: 0, deniedSample: [], failed: 0, failedSample: [] })).toEqual([]);
  const w = walkWarnings({ denied: 42, deniedSample: ['C:\\a', 'C:\\b'], failed: 1, failedSample: [] });
  expect(w.map(x => [x.code, x.params])).toEqual([
    ['scan.accessDenied', { count: 42, sample: 'C:\\a, C:\\b' }],
    ['scan.readErrors', { count: 1 }],
  ]);
  expect(w[0].message).toBe('42 folders could not be read (access denied); their contents are not counted (e.g. C:\\a, C:\\b)');
  expect(w[1].message).toBe('1 folder could not be read because of errors; their contents are not counted');
});

test('errores: EngineError conserva su mensaje; lo demás es error.internal', () => {
  const e = engineError('error.invalidNode', { id: 3 });
  expect(e).toBeInstanceOf(EngineError);
  expect(e).toBeInstanceOf(Error);
  expect(e.code).toBe('error.invalidNode');
  expect(e.message).toBe('Unknown node id: 3');
  expect(toEngineMessage(e)).toBe(e.msg);
  expect(toEngineMessage(new TypeError('x is not a function'))).toEqual({
    code: 'error.internal', params: { error: 'x is not a function' }, message: 'Internal error: x is not a function',
  });
  expect(toEngineMessage('raw')).toMatchObject({ code: 'error.internal', params: { error: 'raw' } });
  const m = msg('elevation.failed', { error: 'cancelled' });
  expect(toEngineMessage(m)).toBe(m);
});

test('http: estados por código y cuerpo JSON que es un EngineMessage', async () => {
  const cases: [unknown, number][] = [
    [engineError('error.invalidPath', { path: 'x' }), 400],
    [engineError('error.notFolder', { path: 'C:\\a.txt' }), 400],
    [engineError('error.cannotOpen', { path: 'C:\\no', error: 'not found' }), 400],
    [engineError('error.invalidNode', { id: 999999999 }), 404],
    [engineError('error.noScan'), 409],
    [engineError('error.scanBusy'), 409],
    [engineError('error.dupBusy'), 409],
    [engineError('error.cancelled'), 409],
    [engineError('error.internal', { error: 'x' }), 500],
    [new Error('kaboom'), 500],
    [engineError('history.notFound', { id: 'x' }), 404],
    [engineError('history.otherRoot', { path: 'C:\\a' }), 409],
    [engineError('history.saveFailed', { error: 'x' }), 500],
    [engineError('history.readFailed', { error: 'x' }), 500],
    [engineError('export.invalidName', { name: 'a/b' }), 400],
    [engineError('export.failed', { error: 'x' }), 500],
    [engineError('export.notFound', { path: 'C:\\x' }), 404],
  ];
  for (const [err, status] of cases) {
    const r = errorResponse(err);
    expect(r.status).toBe(status);
    expect(r.headers.get('content-type')).toBe('application/json; charset=utf-8');
    const body: unknown = await r.json();
    expect(isEngineMessage(body)).toBe(true);
    expect((body as { code: string }).code).toBe(toEngineMessage(err).code);
  }
  expect(httpStatus('elevation.failed')).toBe(500);
  const r = errorResponse(msg('elevation.failed', { error: 'The operation was canceled by the user. (1223)' }), 409);
  expect(r.status).toBe(409);
  expect(await r.json()).toEqual({
    code: 'elevation.failed', params: { error: 'The operation was canceled by the user. (1223)' },
    message: 'Could not relaunch as administrator: The operation was canceled by the user. (1223)',
  });
});

test('isEngineMessage rechaza formas incorrectas', () => {
  expect(isEngineMessage({ error: 'texto' })).toBe(false);
  expect(isEngineMessage({ code: 'a', message: 1 })).toBe(false);
  expect(isEngineMessage({ code: 'a', message: 'b', params: { x: {} } })).toBe(false);
  expect(isEngineMessage({ code: 'a', message: 'b', params: { x: 1, y: 'z' } })).toBe(true);
});
