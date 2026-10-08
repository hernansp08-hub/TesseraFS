// Worker de recorrido. Se activa sólo si este módulo se evalúa fuera del hilo principal,
// así que también funciona dentro del bundle portable (el bundle se carga a sí mismo como worker).
import { DirReader, WALK_WORKER_FLAG, batchTransfer } from './walk.ts';

export interface WorkerTaskMsg { type: 'task'; id: number; refs: number[]; paths: string[]; budgetMs: number; infoClass?: number }

declare const self: { onmessage: ((e: MessageEvent) => void) | null; postMessage(m: unknown, transfer?: Transferable[]): void };

export function runWalkWorker() {
  let reader: DirReader | null = null;
  self.onmessage = (e: MessageEvent) => {
    const m = e.data as WorkerTaskMsg;
    if (!m || m.type !== 'task') return;
    try {
      reader ??= new DirReader(256 * 1024);
      if (m.infoClass) reader.infoClass = m.infoClass;
      const b = reader.run({ refs: m.refs, paths: m.paths }, m.budgetMs);
      self.postMessage({ type: 'result', id: m.id, batch: b, infoClass: reader.infoClass }, batchTransfer(b));
    } catch (err) {
      self.postMessage({ type: 'fail', id: m.id, error: String((err as Error)?.message ?? err) });
    }
  };
  self.postMessage({ type: 'ready' });
}

if (!Bun.isMainThread && process.argv.includes(WALK_WORKER_FLAG)) runWalkWorker();
