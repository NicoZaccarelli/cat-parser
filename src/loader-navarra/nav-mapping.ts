// Mapeo códigos Navarra (Gobierno de Navarra — Catastro urbano) → dominio interno.
//
// Fuente OFICIAL: cada zip trae `destinos_XXX.txt` con los 100 códigos
// oficiales (00..99). Ejemplos:
//   04 VIVIENDA
//   01 SUELO
//   05 ALMACEN
//   09 LOCALES COMERCIALES
//   10 LOCALES INDUSTRIALES
//   11 APARCAMIENTO
//   12 NAVE INDUSTRIAL
//   17 OFICINAS
//   49 RELIGIOSO
//   55 HOSPITAL
//   65 CEMENTERIO
//   87 GARAJE
//   98 TRASTERO
//   81 COMUN PORTAL-ESCALERAS ← excluir
//   82 COMUN TERRAZA          ← excluir
//   83 EDIFICIO MENOR         ← excluir (auxiliar)
//   84 JARDINERIA             ← excluir (no edificado)
//   85 PAVIMENTO              ← excluir
//   86 URBANIZACION           ← excluir
//   89 EN CONSTRUCCION        ← incluir como "En construcción"
//
// Contrato con foralAggregates.ts (predios-mvp): "Vivienda" en use_category
// debe ser el string EXACTO para que la ficha muestre "Residencial".

/**
 * Códigos destino Navarra con mapeo confiable a categorías comunes.
 * Fuente: destinos_XXX.txt oficial del zip.
 */
export const NAV_KNOWN_MAPPING: Record<string, string> = {
  "01": "Suelo",                     // → señal TERRENO en detección
  "02": "Campo de golf",
  "03": "Placa solar",
  "04": "Vivienda",                  // EXACT para foralAggregates → "Residencial"
  "05": "Almacén",
  "06": "Desván",
  "07": "Bajera sin uso",
  "08": "Establo/aprisco",
  "09": "Comercial",                 // Locales comerciales
  "10": "Industrial",                // Locales industriales
  "11": "Aparcamiento",
  "12": "Nave industrial",
  "13": "Almacén industrial",
  "14": "Vestuarios / Comedores",
  "15": "Granja",
  "16": "Silos",
  "17": "Oficinas",
  "18": "Oficina pública",
  "19": "Casa consistorial",
  "20": "Audiencia / Juzgado",
  "21": "Universidad",
  "22": "Instituto",
  "23": "Escuela profesional",
  "24": "Escuela EGB",
  "25": "Colegio / Academia",
  "26": "Guardería",
  "27": "Biblioteca",
  "28": "Museo",
  "29": "Casa de cultura",
  "30": "Casino",
  "31": "Teatro",
  "32": "Cine",
  "33": "Auditorio",
  "34": "Sala de fiestas",
  "35": "Plaza de toros",
  "36": "Estadio",
  "37": "Polideportivo",
  "38": "Piscina",
  "39": "Frontón",
  "40": "Pistas deportivas",
  "41": "Hotel",
  "42": "Residencia",
  "43": "Restaurante",
  "44": "Cafetería / Bar",
  "45": "Pensión",
  "46": "Sociedad",
  "47": "Molino",
  "48": "Construcción indefinida",
  "49": "Religioso",
  "50": "Parque eólico",
  "51": "Telefonía móvil",
  "52": "Bienes especiales",
  "53": "Asilo",
  "54": "Convento",
  "55": "Hospital",
  "56": "Clínica",
  "57": "Ambulatorio",
  "58": "Dispensario",
  "59": "Cuarteles",
  "60": "Cárcel",
  "61": "Estación ferrocarril",
  "62": "Bodega",
  "63": "Servicios públicos",
  "64": "Castillo",
  "65": "Cementerio",
  "66": "Transformador",
  "67": "Almacén agrícola",
  "68": "Depuradora de aguas",
  "69": "Lavadero",
  "70": "Báscula",
  "71": "Depósito de aguas",
  "72": "Caseta bomba de agua",
  "73": "Estanque",
  "74": "Fosos",
  "75": "Parque",
  "76": "Cueva",
  "77": "Muelles",
  "78": "Ruinas",
  "79": "Porche",
  "80": "Edificación especial",
  "87": "Garaje",
  "88": "Sala de calderas",
  "89": "En construcción",
  "90": "Estación servicios",
  "91": "Sede partido político",
  "92": "Casa de campo",
  "93": "Laboratorio",
  "94": "Estación de autobús",
  "95": "Depósito",
  "96": "Estudio",
  "97": "Subestación eléctrica",
  "98": "Trastero",
  "99": "Pozo de agua",
};

/**
 * Códigos destino Navarra que representan ELEMENTOS COMUNES o auxiliares
 * NO tipologizables — se filtran ANTES de agrupar por parcela.
 *   81/82 = zonas comunes de edificio.
 *   83 = edificio menor (caseta auxiliar).
 *   84/85/86 = jardinería/pavimento/urbanización (no edificación).
 *   00 = DESCONOCIDO (dato no informado, tratar como excluido).
 */
export const NAV_EXCLUDE_DESTINOS = new Set<string>([
  "00",
  "81",
  "82",
  "83",
  "84",
  "85",
  "86",
]);

/**
 * Códigos destino que señalan TERRENO (parcela sin edificar edificable
 * o con actividad no-inmueble).
 */
export const NAV_TERRENO_DESTINOS = new Set<string>(["01"]);

export function mapNavDestino(destino: string): {
  category: string;
  wasKnown: boolean;
  isExcluded: boolean;
  isTerreno: boolean;
} {
  const c = destino.trim().padStart(2, "0").slice(0, 2);
  const isExcluded = NAV_EXCLUDE_DESTINOS.has(c);
  const isTerreno = NAV_TERRENO_DESTINOS.has(c);
  if (c in NAV_KNOWN_MAPPING) {
    return {
      category: NAV_KNOWN_MAPPING[c],
      wasKnown: true,
      isExcluded,
      isTerreno,
    };
  }
  return { category: "Desconocido", wasKnown: false, isExcluded: false, isTerreno: false };
}

// ─── Parser ancho fijo unidades_urbanas ─────────────────────────────────────
// Layout REAL (101 chars/línea, LATIN-1), corregido tras validación en
// Pamplona (parcela 02/0532 daba superficies astronómicas por offset drift).
// El prompt inicial documentaba 93 chars con superficies 10v2 — INCORRECTO.
//   Municipio(3) Población(4) Polígono(2) Parcela(4) Subárea(2) Unidad(4)
//   _sep(1) Planta(2) Puerta+Escalera(10) TipoConstr(4) Cat(1)
//   SupPrivativa(12v2) SupCerrada(12v2) SupAbierta(12v2) SupComunes(12v2)
//   AñoConstr(4) GradoRef(1) AñoRef(4) Destino(2) Conserv(3) VivInt(1) Consumo(1)
// = 3+4+2+4+2+4+1+2+10+4+1+12+12+12+12+4+1+4+2+3+1+1 = 101 chars.

export interface UnidadUrbanaRaw {
  mun: string;    // "183"
  pob: string;    // "0001"
  pol: string;    // "01"
  par: string;    // "0001"
  subarea: string; // "01"
  unidad: string; // "0001"
  escalera: string;
  planta: string;
  puerta: string;
  tipoConstr: string;
  categoria: string;
  supPriv: number;
  supCerr: number;
  supAbi: number;
  supCom: number;
  anoConstr: number | null;
  gradoRef: string;
  anoRef: number | null;
  destino: string; // "04"
  conserv: string;
  vivInt: string;
  consumo: string;
}

function slice(line: string, from: number, to: number): string {
  return line.slice(from, to);
}

function parseIntSafe(s: string): number {
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : 0;
}

function parseDecimal12v2(s: string): number {
  const n = parseIntSafe(s.trim());
  return n / 100;
}

function parseYear(s: string): number | null {
  const y = parseIntSafe(s);
  if (y >= 1000 && y <= 2100) return y;
  return null;
}

export function parseUnidadUrbana(line: string): UnidadUrbanaRaw | null {
  if (line.length < 101) return null;
  return {
    mun: slice(line, 0, 3),
    pob: slice(line, 3, 7),
    pol: slice(line, 7, 9),
    par: slice(line, 9, 13),
    subarea: slice(line, 13, 15),
    unidad: slice(line, 15, 19),
    escalera: slice(line, 19, 20),
    planta: slice(line, 20, 22),
    puerta: slice(line, 22, 32).trimEnd(),
    tipoConstr: slice(line, 32, 36),
    categoria: slice(line, 36, 37),
    supPriv: parseDecimal12v2(slice(line, 37, 49)),
    supCerr: parseDecimal12v2(slice(line, 49, 61)),
    supAbi: parseDecimal12v2(slice(line, 61, 73)),
    supCom: parseDecimal12v2(slice(line, 73, 85)),
    anoConstr: parseYear(slice(line, 85, 89)),
    gradoRef: slice(line, 89, 90),
    anoRef: parseYear(slice(line, 90, 94)),
    destino: slice(line, 94, 96),
    conserv: slice(line, 96, 99),
    vivInt: slice(line, 99, 100),
    consumo: slice(line, 100, 101),
  };
}

// ─── Parser vias_XXX.txt ────────────────────────────────────────────────────
// Layout observado en Obanos:
//   Mun(3) Pob(4) CVia(4) Tipo(2) NombreLargo(30 fill spaces) DescripcionLarga
// Ejemplo: "18300010001DSDISEMINADO                    DISEMINADO"

export interface ViaRow {
  cvia: string; // "0001"
  tipo: string; // "DS" (Diseminado), "CL" (Calle), "PZ" (Plaza), etc.
  nombre: string;
  descripcion: string;
}

const TIPO_VIA_LABEL: Record<string, string> = {
  CL: "Calle",
  PZ: "Plaza",
  AV: "Avenida",
  BO: "Barrio",
  PS: "Paseo",
  DS: "Diseminado",
  CT: "Carretera",
  UR: "Urbanización",
  TR: "Travesía",
  RD: "Ronda",
  CS: "Caserío",
  CJ: "Callejón",
  LG: "Lugar",
};

export function labelFromTipoVia(tipo: string): string {
  const t = tipo.trim().toUpperCase();
  return TIPO_VIA_LABEL[t] || t;
}

export function parseVia(line: string): ViaRow | null {
  if (line.length < 15) return null;
  // 3+4+4 = 11 (mun+pob+cvia), luego 2 (tipo), luego nombre padded a 30.
  const cvia = slice(line, 7, 11);
  const tipo = slice(line, 11, 13);
  const nombre = slice(line, 13, 43).trimEnd();
  const descripcion = line.slice(43).trimEnd();
  return { cvia, tipo, nombre, descripcion };
}
