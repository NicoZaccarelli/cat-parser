import type {
  Building,
  CatRecord,
  ConstruccionRecord,
  ParcelaRecord,
  UnidadConstructivaRecord,
  Unit,
} from "../parser/types";

// Altura relativa de los códigos de planta alfabéticos habitables, para
// poder compararlos con las numéricas. Mismos códigos que reconoce
// `isCommonElement` en recordParser.
const PLANTA_ORDINAL: Record<string, number> = {
  SS: -2,   // sótano segundo
  SM: -1,   // sótano / semisótano
  BJ: 0,    // bajo
  PB: 0,    // planta baja
  EN: 0.5,  // entresuelo
  AT: 900,  // ático — por encima de cualquier planta numérica real
};

// Orden entre plantas del Catastro. Solo se usa para quedarse con la planta
// más BAJA de un bien con varios recintos, que es donde el Catastro registra
// el inmueble (por eso la Sede de un edificio de dúplex solo muestra las
// plantas pares). Nunca interviene en la clasificación.
//
// Las no reconocidas ("OM", "-", vacío) se mandan al final: así, si un bien
// mezcla un recinto sin planta con otro que sí la tiene, gana el que la
// tiene. Importa porque `isCommonElement` trata las plantas no reconocidas
// como elemento común, y quedarse con la buena evita que el tipologizador
// descarte una vivienda real.
function plantaHeight(p: string): number {
  const v = p.trim().toUpperCase();
  const n = Number.parseInt(v, 10);
  if (/^-?\d+$/.test(v) && Number.isFinite(n)) return n;
  const ord = PLANTA_ORDINAL[v];
  return ord !== undefined ? ord : Number.POSITIVE_INFINITY;
}

function comparePlanta(a: string, b: string): number {
  const ha = plantaHeight(a);
  const hb = plantaHeight(b);
  if (ha !== hb) return ha < hb ? -1 : 1;
  return 0;
}

const STRING_POOL = new Map<string, string>();
function intern(s: string): string {
  const existing = STRING_POOL.get(s);
  if (existing !== undefined) return existing;
  STRING_POOL.set(s, s);
  return s;
}

export class BuildingGrouper {
  private buildings = new Map<string, Building>();

  // Índice de unidades ya emitidas, por parcela → `${bienInmueble}|${usoChar}`.
  // Guarda REFERENCIAS a los objetos de `building.units`, así que acumular
  // superficie aquí muta la unidad ya empujada. Ver `handleConstruccion`.
  private unitIndex = new Map<string, Map<string, Unit>>();

  /**
   * Contadores de diagnóstico para el gate de validación por provincia.
   * `rowsSinBien` mide filas de construcción sin bien inmueble asignado
   * (elementos comunes). En Madrid capital son ~10% de las filas; una
   * provincia con una proporción muy distinta señala un layout diferente
   * y debe abortar la corrida antes de escribir nada.
   */
  readonly stats = {
    rowsTotal: 0,
    rowsSinBien: 0,
    rowsAgrupadas: 0, // filas que se sumaron a una unidad ya existente
  };

  private ensure(refcat: string): Building {
    let b = this.buildings.get(refcat);
    if (!b) {
      b = {
        refcatParcela: refcat,
        direccion: "",
        numero: "",
        municipio: "",
        provincia: "",
        codigoPostal: "",
        anoConstruccion: null,
        units: [],
      };
      this.buildings.set(refcat, b);
    }
    return b;
  }

  handle(record: CatRecord): void {
    switch (record.type) {
      case "11":
        this.handleParcela(record);
        break;
      case "13":
        this.handleUC(record);
        break;
      case "14":
        this.handleConstruccion(record);
        break;
    }
  }

  private handleParcela(r: ParcelaRecord): void {
    const b = this.ensure(r.refcatParcela);
    if (!b.direccion) {
      const sigla = r.siglaVia ? `${r.siglaVia} ` : "";
      b.direccion = `${sigla}${r.nombreVia}`.trim();
      b.numero = r.numeroPolicia;
      b.municipio = r.nombreMunicipio;
      b.provincia = r.nombreProvincia;
      b.codigoPostal = r.codigoPostal;
    }
  }

  private handleUC(r: UnidadConstructivaRecord): void {
    const b = this.ensure(r.refcatParcela);
    if (r.anoConstruccion) {
      if (b.anoConstruccion == null || r.anoConstruccion < b.anoConstruccion) {
        b.anoConstruccion = r.anoConstruccion;
      }
    }
  }

  // Una unidad = un BIEN INMUEBLE, no una fila de construcción.
  //
  // El registro 14 lista un recinto por fila, y un mismo bien puede ocupar
  // varios: dúplex (una fila por planta), chalets (baja + primera + sótano),
  // viviendas con dos recintos en la misma planta. Empujar una unidad por
  // fila partía esos bienes en varias unidades más pequeñas —Santa Prisca 2
  // (Madrid) salía con 64 viviendas de ~40 m² en vez de 32 de ~80— e
  // infravaloraba cada una a la mitad.
  //
  // Se agrupa por (bienInmueble, usoChar), no solo por bienInmueble: un bien
  // puede tener recintos de usos distintos (RD MATI 45, Manacor: 3 filas de
  // VIVIENDA y 2 de almacén bajo el mismo bien) y la superficie de vivienda
  // no debe absorber la del anexo. Con la clave compuesta, ese bien produce
  // una vivienda de 190 m² y un almacén de 25 m², que es lo correcto.
  //
  // Las filas SIN bien inmueble (posiciones 51-54 en blanco) son elementos
  // comunes —portales, escaleras, viales de garaje— y se descartan: no son
  // unidades. Antes se contaban como viviendas (CL Hermosilla 159 tenía una
  // fila de 32 m² en planta "OM" que figuraba como vivienda).
  private handleConstruccion(r: ConstruccionRecord): void {
    if (r.superficieTotal <= 0) return;
    this.stats.rowsTotal++;

    const b = this.ensure(r.refcatParcela);

    if (r.anoAntiguedad) {
      if (b.anoConstruccion == null || r.anoAntiguedad < b.anoConstruccion) {
        b.anoConstruccion = r.anoAntiguedad;
      }
    }

    if (!r.bienInmueble) {
      this.stats.rowsSinBien++;
      return;
    }

    const trimmedUso = r.uso.trim();
    const usoChar = trimmedUso ? trimmedUso.charAt(0).toUpperCase() : "?";

    let byKey = this.unitIndex.get(r.refcatParcela);
    if (!byKey) {
      byKey = new Map<string, Unit>();
      this.unitIndex.set(r.refcatParcela, byKey);
    }
    const key = `${r.bienInmueble}|${usoChar}`;
    const existing = byKey.get(key);

    if (existing) {
      // Mismo bien y mismo uso → es otro recinto del MISMO inmueble.
      existing.superficie += r.superficieTotal;
      existing.superficieComunes =
        (existing.superficieComunes ?? 0) + r.superficieComunes;
      // La planta que se conserva es la más baja, que es donde el Catastro
      // registra el bien (por eso la Sede solo muestra las pares en un
      // edificio de dúplex). Mantiene coherencia con lo que ve el usuario.
      if (comparePlanta(r.planta || "-", existing.planta) < 0) {
        existing.planta = intern(r.planta || "-");
      }
      this.stats.rowsAgrupadas++;
      return;
    }

    const unit: Unit = {
      usoChar: intern(usoChar),
      planta: intern(r.planta || "-"),
      superficie: r.superficieTotal,
      superficieComunes: r.superficieComunes,
    };
    byKey.set(key, unit);
    b.units.push(unit);
  }

  size(): number {
    return this.buildings.size;
  }

  all(): IterableIterator<Building> {
    return this.buildings.values();
  }

  find(refcat: string): Building | undefined {
    return this.buildings.get(refcat);
  }

  topBySize(n: number): Building[] {
    const arr: Building[] = [];
    for (const b of this.buildings.values()) {
      if (b.units.length > 0) arr.push(b);
    }
    arr.sort((a, b) => b.units.length - a.units.length);
    return arr.slice(0, n);
  }
}
