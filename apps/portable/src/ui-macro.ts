// Macro de Bun: se ejecuta al empaquetar (y al transpilar en desarrollo) e incrusta la interfaz
// como cadena. Si la interfaz aún no está construida devuelve "" y el servidor usa una página mínima.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function embeddedUi(): string {
  const p = join(import.meta.dir, '..', '..', '..', 'packages', 'ui', 'dist', 'index.html');
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
}
