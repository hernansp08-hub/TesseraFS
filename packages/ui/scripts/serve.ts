// Sirve la interfaz compilada con el motor de demostración, para probarla en un navegador:
//   bun packages/ui/build.ts && bun packages/ui/scripts/serve.ts   →  http://127.0.0.1:47801  (#pseudo, #files…)
import { join } from 'path';

const file = join(import.meta.dir, '../dist/index.html'), port = Number(process.env.TESSERA_DEMO_PORT || 47801);
Bun.serve({ hostname: '127.0.0.1', port, fetch: () => new Response(Bun.file(file), { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } }) });
console.log(`Demo: http://127.0.0.1:${port}`);
