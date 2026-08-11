import type {
  CabeceraRecord,
  ParcelaRecord,
  UnidadConstructivaRecord,
  ConstruccionRecord,
  BienInmuebleRecord,
  CatRecord,
} from "./types";

function slice(line: string, from: number, to: number): string {
  return line.substring(from - 1, to);
}

function parseIntSafe(s: string): number {
  const n = parseInt(s.trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

function parseYearSafe(s: string): number | null {
  const y = parseInt(s.trim(), 10);
  if (!Number.isFinite(y) || y < 1000 || y > 2100) return null;
  return y;
}

function clean(s: string): string {
  return s.trim().replace(/\s+/g, " ");
}

export function parseLine(line: string): CatRecord | null {
  if (line.length < 2) return null;
  const tipo = line.substring(0, 2);
  switch (tipo) {
    case "01":
      return parseCabecera(line);
    case "11":
      return parseParcela(line);
    case "13":
      return parseUnidadConstructiva(line);
    case "14":
      return parseConstruccion(line);
    case "15":
      return parseBienInmueble(line);
    default:
      return null;
  }
}

function parseCabecera(line: string): CabeceraRecord {
  return {
    type: "01",
    provincia: clean(slice(line, 3, 5)),
    municipio: clean(slice(line, 13, 39)),
    fechaGeneracion: clean(slice(line, 40, 53)),
  };
}

function parseParcela(line: string): ParcelaRecord {
  return {
    type: "11",
    refcatParcela: slice(line, 31, 44).trim(),
    codMuniDGC: slice(line, 24, 30).trim(),
    provinciaINE: slice(line, 51, 52).trim(),
    municipioINE: slice(line, 81, 83).trim(),
    nombreProvincia: clean(slice(line, 53, 77)),
    nombreMunicipio: clean(slice(line, 84, 123)),
    codVia: slice(line, 154, 158).trim(),
    siglaVia: slice(line, 159, 160).trim(),
    nombreVia: clean(slice(line, 161, 185)),
    numeroPolicia: slice(line, 189, 192).trim().replace(/^0+/, "") || "",
    codigoPostal: slice(line, 216, 220).trim(),
  };
}

function parseUnidadConstructiva(line: string): UnidadConstructivaRecord {
  return {
    type: "13",
    refcatParcela: slice(line, 31, 44).trim(),
    cargoUC: slice(line, 45, 48).trim(),
    anoConstruccion: parseYearSafe(slice(line, 296, 299)),
  };
}

function parseConstruccion(line: string): ConstruccionRecord {
  return {
    type: "14",
    refcatParcela: slice(line, 31, 44).trim(),
    cargoUC: slice(line, 45, 48).trim(),
    bienInmueble: slice(line, 51, 54).trim(),
    bloque: slice(line, 59, 62).trim(),
    escalera: slice(line, 63, 64).trim(),
    planta: slice(line, 65, 67).trim(),
    puerta: slice(line, 68, 70).trim(),
    uso: slice(line, 71, 73),
    anoAntiguedad: parseYearSafe(slice(line, 79, 82)),
    superficieTotal: parseIntSafe(slice(line, 84, 90)),
    superficieTerrazas: parseIntSafe(slice(line, 91, 97)),
    superficieComunes: parseIntSafe(slice(line, 98, 104)),
  };
}

function parseBienInmueble(line: string): BienInmuebleRecord {
  return {
    type: "15",
    refcatParcela: slice(line, 31, 44).trim(),
    refcatCompleta: slice(line, 31, 50).trim(),
    cargoLocal: slice(line, 45, 48).trim(),
    superficieConstruida: parseIntSafe(slice(line, 442, 451)),
    coeficienteParticipacion: parseIntSafe(slice(line, 462, 466)),
  };
}

// Cuadro 2 del ANEXO del formato CAT — "CODIFICACIÓN DE LOS USOS DE LOS
// BIENES INMUEBLES". Fuente: Dirección General del Catastro, "Fichero
// informático de remisión de catastro", revisión 16-11-2022.
// https://www.catastro.hacienda.gob.es/documentos/formatos_intercambio/catastro_fin_cat_2006.pdf
//
// ⚠️ NO IMPROVISES ETIQUETAS AQUÍ. Tres de estas claves estuvieron mal desde
// el commit inicial (02-05-2026) porque se dedujeron del código en vez de
// leerlas del cuadro, y el error viajó a todas las provincias cargadas:
//
//   G  decía "Ganadero"              y es Ocio y Hostelería.  273.569 filas.
//      Los códigos reales de Madrid capital lo delatan: GH1..GH5 (hoteles por
//      estrellas), GR1..GR5 (restaurantes), GC1..GC5, GP1..GP3. Nada ganadero.
//   J  decía "Industrial no agrario" y es Industrial agrario — invertido.
//   T  decía "Espectáculos / Ocio"   y es solo Espectáculos; el ocio es G.
//   M  se dejaba a medias: el cuadro añade "suelos sin edificar".
//
// V se queda como "Vivienda" y no como el "Residencial" del cuadro: el
// literal es la clave del gate residencial de la app
// (RESIDENTIAL_USE_CATEGORY en predios-mvp/app/lib/typologyRules.ts) y de la
// deduplicación de `saved_properties`. Cambiarlo son cuatro sitios a la vez.
// Decisión congelada.
const USO_CATEGORIAS: Record<string, string> = {
  A: "Almacén-Estacionamiento",
  V: "Vivienda", // el cuadro dice "Residencial"; ver nota arriba
  I: "Industrial",
  O: "Oficinas",
  C: "Comercial",
  K: "Deportivo",
  T: "Espectáculos",
  G: "Ocio y Hostelería",
  // El cuadro dice "Sanidad y Beneficencia"; se conserva la barra por no
  // abrir una quinta migración de datos fuera del alcance acordado. La
  // diferencia es tipográfica, no de significado.
  Y: "Sanidad / Beneficencia",
  E: "Cultural",
  R: "Religioso",
  M: "Obras de urbanización y jardinería, suelos sin edificar",
  P: "Edificio singular",
  B: "Almacén agrario",
  J: "Industrial agrario",
  Z: "Agrario",
};

const HABITABLE_CODES = new Set(["SM", "SS", "BJ", "EN", "AT", "PB"]);

export function isCommonElement(planta: string): boolean {
  const p = planta.trim().toUpperCase();
  if (/^-?\d+$/.test(p)) return false;
  if (HABITABLE_CODES.has(p)) return false;
  return true;
}

export function classifyUso(uso: string): string {
  const trimmed = uso.trim();
  if (!trimmed) return "Desconocido";
  const first = trimmed.charAt(0).toUpperCase();
  return USO_CATEGORIAS[first] || `Otro (${first})`;
}
