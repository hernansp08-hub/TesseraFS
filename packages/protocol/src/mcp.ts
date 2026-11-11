// Herramientas e instrucciones del servidor MCP como datos (mcp-tools.json): las anuncian tal cual tessera-cli mcp
// (crates/tessera-cli/src/mcp.rs, con include_str!) y la edición portable (apps/portable/src/mcp.ts). Así las dos
// ediciones no se desincronizan. Aquí sólo se sustituye cada {"$ref": "#/$defs/<nombre>"} por esa definición.
// No se exporta desde index.ts: la interfaz no lo necesita.
import data from './mcp-tools.json';

export interface McpToolAnnotations { title: string; readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean }
/** Una herramienta tal como la devuelve tools/list. */
export interface McpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
  annotations: McpToolAnnotations;
}

const REF = /^#\/\$defs\/(\w+)$/;
function resolve(v: unknown, defs: Record<string, unknown>): unknown {
  if (Array.isArray(v)) return v.map(x => resolve(x, defs));
  if (!v || typeof v !== 'object') return v;
  const o = v as Record<string, unknown>;
  if ('$ref' in o) {
    const k = REF.exec(String(o.$ref))?.[1];
    if (!k || !Object.hasOwn(defs, k)) throw new Error(`mcp-tools.json: $ref desconocida ${JSON.stringify(o.$ref)}`);
    return resolve(defs[k], defs);
  }
  return Object.fromEntries(Object.entries(o).map(([key, x]) => [key, resolve(x, defs)]));
}

/** `instructions` de la respuesta a initialize: cómo usar las herramientas. */
export const MCP_INSTRUCTIONS: string = data.instructions;
/** Lo que devuelve tools/list. */
export const MCP_TOOLS = resolve(data.tools, data.$defs) as McpTool[];
