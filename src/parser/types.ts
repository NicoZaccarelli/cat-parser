export interface CabeceraRecord {
  type: "01";
  provincia: string;
  municipio: string;
  fechaGeneracion: string;
}

export interface ParcelaRecord {
  type: "11";
  refcatParcela: string;
  codMuniDGC: string;
  provinciaINE: string;
  municipioINE: string;
  nombreProvincia: string;
  nombreMunicipio: string;
  codVia: string;
  siglaVia: string;
  nombreVia: string;
  numeroPolicia: string;
  codigoPostal: string;
}

export interface UnidadConstructivaRecord {
  type: "13";
  refcatParcela: string;
  cargoUC: string;
  anoConstruccion: number | null;
}

export interface ConstruccionRecord {
  type: "14";
  refcatParcela: string;
  cargoUC: string;
  bloque: string;
  escalera: string;
  planta: string;
  puerta: string;
  uso: string;
  anoAntiguedad: number | null;
  superficieTotal: number;
  superficieTerrazas: number;
  superficieComunes: number;
}

export interface BienInmuebleRecord {
  type: "15";
  refcatParcela: string;
  refcatCompleta: string;
  cargoLocal: string;
}

export type CatRecord =
  | CabeceraRecord
  | ParcelaRecord
  | UnidadConstructivaRecord
  | ConstruccionRecord
  | BienInmuebleRecord;

export interface Unit {
  usoChar: string;
  planta: string;
  superficie: number;
}

export interface Building {
  refcatParcela: string;
  direccion: string;
  numero: string;
  municipio: string;
  provincia: string;
  codigoPostal: string;
  anoConstruccion: number | null;
  units: Unit[];
}

export interface Tipologia {
  nombre: string;
  numUnidades: number;
  m2Medio: number;
  m2Min: number;
  m2Max: number;
  plantas: string[];
}

export interface BuildingTipologias {
  refcatParcela: string;
  direccion: string;
  municipio: string;
  anoConstruccion: number | null;
  totalUnidades: number;
  porUso: Record<string, Tipologia[]>;
}

export interface ParseStats {
  linesRead: number;
  type01: number;
  type11: number;
  type13: number;
  type14: number;
  type15: number;
  type16: number;
  type17: number;
  type90: number;
  otros: number;
  errors: number;
}
