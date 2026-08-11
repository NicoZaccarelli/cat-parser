// Mapeo códigos GFA (Diputación Foral de Gipuzkoa) → dominio interno.
//
// Fuente: PDF oficial `urbanadocayudav2.pdf` en el portal de datos abiertos
// (https://www.gipuzkoairekia.eus/es/datu-irekien-katalogoa/-/openDataSearcher/detail/detailView/f249fd69-9765-4850-9bf8-c3ad457d848e).
// El PDF está en un subdominio interno (opepro08.sare.gipuzkoa.net) que
// no es públicamente accesible. La tabla siguiente es INFERIDA por
// prevalencia observada en Donostia (247.712 filas concatenadas) y por
// analogía con la nomenclatura DGC estándar. Contacto oficial para
// refinamientos: hirilurra@gipuzkoa.eus.
//
// TRAMPA importante: la columna 4 del CSV ("D", una letra) NO es destino
// — es un código distinto (¿división? ¿distrito?). El destino real está
// en la columna 14 (con nombre "De"). Este mapping se aplica sobre "De".
//
// Contrato con foralAggregates.ts:
//   El valor "Vivienda" (con capitalización EXACTA) es el que hace que
//   la ficha muestre "Residencial" en usoPrincipal. Cualquier cambio de
//   nomenclatura aquí rompería la coherencia visual con DGC/BFA.

/**
 * Códigos GFA con mapeo de alta/media confianza a categorías comunes
 * (mismas usadas por DGC y BFA, alineadas con USO_CATEGORIAS del parser
 * nacional en src/parser/recordParser.ts).
 */
export const GFA_KNOWN_MAPPING: Record<string, string> = {
  // ─ Confianza alta ─
  V: "Vivienda",              // 96.238 en Donostia = viviendas oficiales
  P: "Aparcamiento",          // 49.003 = plazas de parking bajo rasante
  T: "Trastero",              // 34.454 = trasteros/anexos
  G: "Garaje",                // 20.114 = garajes privados (separados de P)
  C: "Comercial",             // 12.522 = locales comerciales
  O: "Oficinas",              // 3.694  (misma letra que DGC O=Oficinas)
  I: "Industrial",            // 1.511  (misma letra que DGC I=Industrial)
  K: "Deportivo",             // 709    (misma letra que DGC K=Deportivo)
  R: "Religioso",             // 224    (misma letra que DGC R=Religioso)
  Y: "Sanidad / Beneficencia",// 33     (misma letra que DGC Y=Sanidad)
  // 24 en Donostia. Mapeado por analogía con DGC T (misma letra que DGC T,
  // pero GFA usa T=Trastero). Sigue la corrección de USO_CATEGORIAS: el
  // cuadro 2 de la DGC dice "Espectáculos" a secas — el ocio es la letra G,
  // que en GFA significa Garaje. Sin este cambio, la próxima carga de
  // Gipuzkoa reintroduciría el literal viejo justo después del UPDATE.
  Q: "Espectáculos",

  // ─ Confianza media (analogía DGC; consultar hirilurra@gipuzkoa.eus si dudas) ─
  E: "Cultural",              // 805 — DGC E=Cultural
  A: "Almacén",               // 141 — DGC A=Almacén-Estacionamiento (aquí solo Almacén)
  M: "Obras urbanización",    // 2.672 — DGC M=Obras urbanización
};

/**
 * Códigos GFA observados en Donostia pero SIN mapeo confiable a categoría.
 * Se mapean a "Otros" — mejor que mentir con una categoría específica.
 * TODO: consultar tabla oficial (PDF urbanadocayudav2.pdf) para refinar.
 */
export const GFA_UNKNOWN_CODES = new Set<string>([
  "Z", // 6.452 — DGC Z=Agrario, pero Donostia tiene poco agrario (¿otra cosa?)
  "X", // 4.094
  "J", // 1.160 — DGC J=Industrial agrario (dudoso en Donostia)
  "S", // 943
  "H", // 605
  "B", // 400 — DGC B=Almacén agrario (dudoso)
  "W", // 337
  "N", // 233
  "D", // 44
  "L", // 41
  "U", // 40
]);

/**
 * Códigos GFA que representan elementos comunes o filas técnicas
 * (columna Om). El loader FILTRA estas filas antes de mapear el destino.
 * `EC` = elemento común (equivalente a plantas OM del DGC).
 * Otros valores observados (MP, MI, ES) son mantenidos por ahora — se
 * incluirán en el batch normal y el typologizer los agrupará como
 * tipologías. Si aparecen anomalías post-carga, revisar caso a caso.
 */
export const GFA_OM_EXCLUDE = new Set<string>(["EC"]);

export type GfaMappingWarning = {
  code: string;
  count: number;
  category: "otros" | "desconocido";
};

/**
 * Mapea un código De de GFA a categoría común.
 * - Si está en KNOWN_MAPPING → devuelve la categoría oficial.
 * - Si está en UNKNOWN_CODES → devuelve "Otros" (código conocido, semántica dudosa).
 * - Cualquier otro código → devuelve "Desconocido" (señal de dato raro o
 *   bug; el caller debe loguearlo).
 */
export function mapGfaDestino(de: string): {
  category: string;
  wasKnown: boolean;
} {
  const c = de.trim().toUpperCase();
  if (!c) return { category: "Otros", wasKnown: true };
  if (c in GFA_KNOWN_MAPPING) {
    return { category: GFA_KNOWN_MAPPING[c], wasKnown: true };
  }
  if (GFA_UNKNOWN_CODES.has(c)) {
    return { category: "Otros", wasKnown: true };
  }
  return { category: "Desconocido", wasKnown: false };
}
