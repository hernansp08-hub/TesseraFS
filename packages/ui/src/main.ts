// Punto de entrada: elige el motor según dónde se ejecuta la interfaz.
import type { Backend } from '@tessera/protocol';
import { DemoBackend } from './backends/demo';
import { HttpBackend, TauriBackend } from './backends/remote';
import { startApp } from './app';

function pickBackend(): Backend {
  if (window.__TAURI__?.core) return new TauriBackend();
  if (window.__TESSERA__?.backend === 'http') return new HttpBackend(window.__TESSERA__.token);
  return new DemoBackend();
}

startApp(pickBackend());
