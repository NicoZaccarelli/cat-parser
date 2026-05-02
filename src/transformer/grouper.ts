import type {
  Building,
  CatRecord,
  ConstruccionRecord,
  ParcelaRecord,
  UnidadConstructivaRecord,
  Unit,
} from "../parser/types";

const STRING_POOL = new Map<string, string>();
function intern(s: string): string {
  const existing = STRING_POOL.get(s);
  if (existing !== undefined) return existing;
  STRING_POOL.set(s, s);
  return s;
}

export class BuildingGrouper {
  private buildings = new Map<string, Building>();

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

  private handleConstruccion(r: ConstruccionRecord): void {
    if (r.superficieTotal <= 0) return;
    const b = this.ensure(r.refcatParcela);
    const trimmedUso = r.uso.trim();
    const usoChar = trimmedUso ? trimmedUso.charAt(0).toUpperCase() : "?";
    const unit: Unit = {
      usoChar: intern(usoChar),
      planta: intern(r.planta || "-"),
      superficie: r.superficieTotal,
    };
    b.units.push(unit);
    if (r.anoAntiguedad) {
      if (b.anoConstruccion == null || r.anoAntiguedad < b.anoConstruccion) {
        b.anoConstruccion = r.anoAntiguedad;
      }
    }
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
