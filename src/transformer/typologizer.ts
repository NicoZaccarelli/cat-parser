import { classifyUso, isCommonElement } from "../parser/recordParser";
import type {
  Building,
  BuildingTipologias,
  Tipologia,
  Unit,
} from "../parser/types";

const TOLERANCIA = 0.05; // Cambiado de 0.1 a 0.05 (29-04-2026): agrupación más estricta

function generarTipologias(units: Unit[]): Tipologia[] {
  if (units.length === 0) return [];
  const ordenadas = [...units].sort((a, b) => a.superficie - b.superficie);
  const grupos: Unit[][] = [];
  let actual: Unit[] = [ordenadas[0]];
  let min = ordenadas[0].superficie;
  let max = ordenadas[0].superficie;
  for (let i = 1; i < ordenadas.length; i++) {
    const u = ordenadas[i];
    const tentativeMin = Math.min(min, u.superficie);
    const tentativeMax = Math.max(max, u.superficie);
    const mediaTent = (tentativeMin + tentativeMax) / 2;
    const rango = tentativeMax - tentativeMin;
    if (mediaTent === 0 || rango / mediaTent <= TOLERANCIA * 2) {
      actual.push(u);
      min = tentativeMin;
      max = tentativeMax;
    } else {
      grupos.push(actual);
      actual = [u];
      min = u.superficie;
      max = u.superficie;
    }
  }
  grupos.push(actual);

  return grupos.map((grupo, idx) => {
    const superficies = grupo.map((u) => u.superficie);
    const sum = superficies.reduce((a, b) => a + b, 0);
    // Media construida = privativa + comunes imputados, sobre el MISMO grupo
    // (agrupado por privativa).
    //
    // ⚠️ DORMIDO en Madrid capital (verificado 2026-08-04). El CAT masivo de la
    // DGC NO imputa comunes por bien: el registro tipo 14, posiciones 98-104
    // (superficieComunes), viene a CERO en toda la capital (fichero 28900U). Los
    // elementos comunes existen como filas tipo-14 aparte a nivel de edificio,
    // no repartidos por vivienda. Por eso aquí m2MedioConstruida == m2Medio para
    // Madrid, y el "IBI estimado" de la app NO usa este campo: calibra el ratio
    // comunes/privativa en runtime vía DNPRC por bien (Sede/DNPRC sí imputa por
    // coeficiente de participación). Se conserva el cálculo porque otras
    // provincias o los forales pueden sí traer superficieComunes > 0.
    const sumConstruida = grupo.reduce(
      (a, u) => a + u.superficie + (u.superficieComunes ?? 0),
      0,
    );
    const plantas = Array.from(new Set(grupo.map((u) => u.planta || "-")));
    plantas.sort((a, b) => {
      const na = parseInt(a, 10);
      const nb = parseInt(b, 10);
      if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
      return a.localeCompare(b);
    });
    return {
      nombre: letraTipologia(idx),
      numUnidades: grupo.length,
      m2Medio: Math.round(sum / grupo.length),
      m2MedioConstruida: Math.round(sumConstruida / grupo.length),
      m2Min: Math.min(...superficies),
      m2Max: Math.max(...superficies),
      plantas,
    };
  });
}

function letraTipologia(idx: number): string {
  if (idx < 26) return String.fromCharCode(65 + idx);
  const primary = Math.floor(idx / 26) - 1;
  const secondary = idx % 26;
  return (
    String.fromCharCode(65 + primary) + String.fromCharCode(65 + secondary)
  );
}

export function tipologizarEdificio(b: Building): BuildingTipologias {
  const porUsoUnits: Record<string, Unit[]> = {};
  let unidadesContadas = 0;
  for (const u of b.units) {
    if (isCommonElement(u.planta)) continue;
    unidadesContadas++;
    const categoria = classifyUso(u.usoChar);
    if (!porUsoUnits[categoria]) porUsoUnits[categoria] = [];
    porUsoUnits[categoria].push(u);
  }

  const porUso: Record<string, Tipologia[]> = {};
  for (const [uso, units] of Object.entries(porUsoUnits)) {
    porUso[uso] = generarTipologias(units);
  }

  const direccionCompleta = [b.direccion, b.numero].filter(Boolean).join(" ");

  return {
    refcatParcela: b.refcatParcela,
    direccion: direccionCompleta.trim(),
    municipio: b.municipio,
    anoConstruccion: b.anoConstruccion,
    totalUnidades: unidadesContadas,
    porUso,
  };
}

export function totalTipologias(tipos: BuildingTipologias): number {
  let n = 0;
  for (const arr of Object.values(tipos.porUso)) n += arr.length;
  return n;
}

export function compactFloors(plantas: string[]): string {
  const numericos: number[] = [];
  const otros: string[] = [];
  for (const p of plantas) {
    const n = parseInt(p, 10);
    if (Number.isFinite(n) && /^-?\d+$/.test(p)) numericos.push(n);
    else if (p.trim()) otros.push(p);
  }
  numericos.sort((a, b) => a - b);
  const partes: string[] = [];
  let i = 0;
  while (i < numericos.length) {
    let j = i;
    while (j + 1 < numericos.length && numericos[j + 1] === numericos[j] + 1) {
      j++;
    }
    partes.push(
      i === j ? String(numericos[i]) : `${numericos[i]}-${numericos[j]}`,
    );
    i = j + 1;
  }
  partes.push(...otros.sort());
  return partes.join(",");
}
