// Reglas de «Liberar espacio» como datos (clean-rules.json): las mismas para la interfaz (packages/ui/src/clean.ts),
// que las convierte en filtros, y para tessera-cli mcp (crates/tessera-cli/src/clean.rs, con include_str!).
//
// Cada regla trae candidatos con una consulta del lenguaje de búsqueda (`q`, la ejecuta el motor) y los afina con
// condiciones sobre el nombre, la ruta, la extensión y los atributos. Lo que en código serían funciones se escribe así:
//   · Expresiones regulares en texto. En las reglas de Windows (`sep: "\\"`), `/` significa el separador `\`, para
//     no doblar barras: "^[A-Z]:/Windows/Temp$". Sin mayúsculas según `ignoreCase` del sistema, salvo
//     { "re": "…", "i": false }. `{var}` inserta `vars.var` entre (?:…); también en `q`, tal cual.
//   · Variantes: la primera cuyas condiciones se cumplen da la herramienta (`label`), la orden y el título
//     (npm, Chrome, APT…); con variantes, un elemento que no encaja en ninguna no es candidato.
//   · Plantillas en `titleParams` y `cmd`: {label} (la variante, o el nombre), {name}, {path} y {lastTwo}
//     («restic › e4b1c9a07d», la carpeta con su padre).
// Sólo sintaxis común a JavaScript y al crate regex de Rust: sin lookaround ni referencias hacia atrás.
import data from './clean-rules.json';
import type { FLAG } from './types';

export type CleanRisk = 'ok' | 'warn' | 'bad';
export type CleanPattern = string | { re: string; i: boolean };
/** Condiciones sobre un elemento: se cumplen todas las presentes. */
export interface CleanMatch {
  name?: CleanPattern;
  path?: CleanPattern;
  /** La ruta no debe encajar (programas instalados, una node_modules dentro de otra…). */
  notPath?: CleanPattern;
  ext?: CleanPattern;
  /** Atributo que debe llevar, como en FLAG. */
  flag?: keyof typeof FLAG;
}
export interface CleanVariant extends CleanMatch {
  /** Lo que pone {label}: la herramienta o el programa. */
  label?: string;
  /** Orden propia de la variante (plantilla). */
  cmd?: string;
  /** Clave del título en lugar de clean.<id>.title. */
  title?: string;
}
export interface CleanRuleSpec {
  id: string;
  /** Consulta que trae los candidatos. */
  q: string;
  risk: CleanRisk;
  ok?: CleanMatch;
  variants?: CleanVariant[];
  /** Nombres de hijos (en minúsculas) que confirman el candidato; basta uno. */
  needs?: string[];
  /** Parámetros del título (plantillas). */
  titleParams?: Record<string, string>;
  /** Orden que se puede copiar (plantilla). */
  cmd?: string;
  /** La orden sólo se propone si ocupa en disco al menos esta fracción de su tamaño (aún sin comprimir). */
  cmdMinAlloc?: number;
  /** Texto «cómo»: true = clean.<id>.how; un id = el de otra regla. */
  how?: true | string;
  useAlloc?: boolean;
  action?: 'freeUp';
  parent?: true;
  list?: 'query' | 'links';
  group?: boolean;
  /** Tamaño mínimo para proponerlo, con las unidades de la búsqueda (base 1024): "50m", "1g". */
  min?: string;
  /** Nota para quien mantiene las reglas; no se muestra. */
  $comment?: string;
}
export interface CleanRuleSet {
  ignoreCase: boolean;
  /** Separador de las rutas del sistema. */
  sep: '\\' | '/';
  vars: Record<string, string>;
  /** En orden: la caché declarada (cacheTag) va al final para no repetir carpetas que ya tienen tarjeta. */
  rules: CleanRuleSpec[];
}
export interface CleanRules { windows: CleanRuleSet; linux: CleanRuleSet }

export const CLEAN_RULES = data as CleanRules;
