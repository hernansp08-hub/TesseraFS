// Punto de entrada: elige el motor según dónde se ejecuta la interfaz.
import type { Backend } from '@tessera/protocol';
import { DemoBackend } from './backends/demo';
import { HttpBackend, TauriBackend } from './backends/remote';
import { startApp } from './app';

function pickBackend(): Backend {
  if (window.__TAURI__?.core) return new TauriBackend();
  if (window.__TESSERA__?.backend === 'http') return new HttpBackend(window.__TESSERA__.token);
  // La demo simula Windows; con #os=linux, un Ubuntu (rutas con «/», reglas y textos de Linux)
  return new DemoBackend(/(?:^#|[,+&])os=linux\b/i.test(location.hash) ? 'linux' : 'windows');
}

startApp(pickBackend());
