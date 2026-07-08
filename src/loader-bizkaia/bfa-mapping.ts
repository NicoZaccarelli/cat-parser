// Mapeo códigos BFA (Bizkaiko Foru Aldundia) → dominio interno.
// Fuente: E:\canScan\cat\Bizkaia\docs\000_Glosario_Terminos_Descarga_Catastral.pdf
//
// TRAMPA (per prompt): Es_Viviend = "vivienda INTERIOR", NO "es vivienda".
// Las viviendas se cuentan SIEMPRE por Codigo_Uso='V' (en capa Elemento).

export type BfaUso = string; // primer char de Codigo_Uso

export const USO_VIVIENDA = "V";

// Códigos de Uso rústico (per prompt).
export const USOS_RUSTICO = new Set(["U", "G", "M", "N", "Q", "W", "F", "H", "Z"]);

// 'Y' = anexos (trasteros/garajes) — NO son vivienda.
export const USO_ANEXO = "Y";

// 'S' = solares → señal TERRENO.
export const USO_SOLAR = "S";

// Clase de vivienda (uso='V'):
//   1 = colectiva (plurifamiliar)
//   2 = unifamiliar urbana
//   3 = unifamiliar rural
//   4 = otras
export type BfaClaseVivienda = "1" | "2" | "3" | "4";

export function isViviendaUso(uso: string): boolean {
  return uso.trim().toUpperCase() === USO_VIVIENDA;
}

export function isUnifamiliar(codigoCla: string): boolean {
  const c = codigoCla.trim();
  return c === "2" || c === "3";
}

export function isPlurifamiliar(codigoCla: string): boolean {
  return codigoCla.trim() === "1";
}

export function isTerrenoUso(uso: string): boolean {
  return uso.trim().toUpperCase() === USO_SOLAR;
}

// Codigo_Nat de Subparcela (per prompt): Urb/Rust/NoCat/BICE → señal para TERRENO.
export function isSueloSubparcela(codigoNat: string): boolean {
  const n = codigoNat.trim().toUpperCase();
  return n === "URB" || n === "RUST" || n === "NOCAT";
}

// Traduce Codigo_Pla (planta) BFA a formato compatible con isCommonElement()
// de cat-parser: números explícitos ("00","01"...) o códigos habitables
// (SM, SS, BJ, EN, AT, PB). BFA usa numérico "01","02"... o códigos como "PB",
// "SM", "SS". El helper habilitable de cat-parser ya cubre esos códigos.
export function normalizePlanta(codigoPla: string): string {
  const p = codigoPla.trim().toUpperCase();
  if (!p) return "";
  // BFA usa "PB" (Planta Baja), "SM" (Semisótano), "SS" (Sótano), "EN" (Entreplanta),
  // "AT" (Ático) — todos ya reconocidos por HABITABLE_CODES de cat-parser.
  // Números: "01" → "1" para que isCommonElement veaun número.
  if (/^\d+$/.test(p)) return String(parseInt(p, 10));
  if (/^-\d+$/.test(p)) return p;
  return p;
}
