import type { BuildingGrouper } from "./grouper";

// Gate de validación del layout del CAT. Corre DESPUÉS de procesar el fichero
// y ANTES de escribir nada en Supabase: si el fichero no cuadra, la corrida
// aborta en vez de envenenar la base a medias.
//
// Existe porque `m2AvgConstruida` y el agrupamiento por bien inmueble dependen
// de posiciones fijas del registro (51-54 del tipo 14, 442-451 y 462-466 del
// tipo 15) verificadas empíricamente en Madrid capital y Manacor. Una
// provincia cuyo layout difiera produciría datos plausibles y falsos, que es
// la peor clase de error: nadie los detecta.
//
// ─── Criterios de ABORTO ────────────────────────────────────────────────────
//
//  1. ratio construida/privativa fuera de [0,95 – 3,0] en demasiados bienes.
//     Por debajo de 1 no tiene sentido físico; por encima de 3 el campo no es
//     una superficie construida. Medido: 0,18%–1,65% en las 8 provincias
//     contrastadas, muy lejos del 5% de tolerancia.
//
//  2. Σ construida de los bienes ≉ privativa + comunes, por parcela. Es la
//     comprobación MÁS DIRECTA de que 442-451 significa lo que creemos, y la
//     que de verdad protege la corrida. Medido: 0,1%–0,4% de parcelas fuera.
//
//  3. Cobertura mínima de superficie construida en el registro 15. Si una
//     provincia trae el campo mayoritariamente a cero, `m2AvgConstruida`
//     volvería a nacer muerta y hay que enterarse antes, no después.
//
// ─── Solo AVISO ─────────────────────────────────────────────────────────────
//
//  · Σ de coeficientes de participación por parcela ≠ 100%. NO aborta: la
//    causa es tipología edificatoria, no formato. Cuando los bienes de una
//    parcela no comparten elementos comunes —casas independientes sobre una
//    misma parcela catastral— cada uno lleva coeficiente 100,00% y la suma da
//    n×100%. En Palma es el 12,5% de las parcelas y en Madrid capital el 0,2%;
//    fallaba en 5 de las 8 provincias contrastadas siendo todas correctas.
//    Además el coeficiente solo interviene en el escalón 2 de la cascada de
//    `finalize()`, que cubre ~5% de los bienes.

export interface GateThresholds {
  maxPctRatioFuera: number;
  maxPctSumaFuera: number;
  minPctCoberturaT15: number;
  /** Solo para el aviso de coeficientes; no aborta. */
  avisoPctCoefFuera: number;
}

export const DEFAULT_THRESHOLDS: GateThresholds = {
  maxPctRatioFuera: 5,
  maxPctSumaFuera: 20,
  minPctCoberturaT15: 50,
  avisoPctCoefFuera: 15,
};

export interface GateResult {
  passed: boolean;
  errores: string[];
  avisos: string[];
  metricas: Record<string, string>;
}

const pct = (a: number, b: number): number => (b > 0 ? (100 * a) / b : 0);
const f1 = (n: number): string => n.toFixed(1);
const f2 = (n: number): string => n.toFixed(2);

export function runValidationGate(
  grouper: BuildingGrouper,
  thresholds: GateThresholds = DEFAULT_THRESHOLDS,
): GateResult {
  const s = grouper.stats;
  const errores: string[] = [];
  const avisos: string[] = [];

  const bienesConDato = s.construidaDeT15 + s.construidaClampeada;
  const bienesTotal =
    s.construidaDeT15 +
    s.construidaImputadaPorCoef +
    s.construidaSinDato +
    s.construidaClampeada;

  const pctRatioFuera = pct(s.construidaClampeada, Math.max(1, bienesConDato));
  const pctCobertura = pct(bienesConDato, Math.max(1, bienesTotal));
  const pctSumaFuera = pct(s.sumaParcelasFuera, Math.max(1, s.sumaParcelas));
  const pctCoefFuera = pct(s.coefParcelasFuera, Math.max(1, s.coefParcelasOk + s.coefParcelasFuera));
  const ratioMedio = s.ratioN > 0 ? s.ratioSum / s.ratioN : 0;

  if (pctRatioFuera > thresholds.maxPctRatioFuera) {
    errores.push(
      `ratio construida/privativa fuera de [0,95–3,0] en ${f2(pctRatioFuera)}% de bienes ` +
        `(máximo ${thresholds.maxPctRatioFuera}%) — el layout del registro 15 no coincide`,
    );
  }
  if (s.sumaParcelas > 0 && pctSumaFuera > thresholds.maxPctSumaFuera) {
    errores.push(
      `Σ construida ≉ privativa + comunes en ${f1(pctSumaFuera)}% de parcelas ` +
        `(máximo ${thresholds.maxPctSumaFuera}%) — las posiciones 442-451 no son superficie construida`,
    );
  }
  if (bienesTotal > 0 && pctCobertura < thresholds.minPctCoberturaT15) {
    errores.push(
      `cobertura de superficie construida en el registro 15 de solo ${f1(pctCobertura)}% ` +
        `(mínimo ${thresholds.minPctCoberturaT15}%) — m2AvgConstruida quedaría casi vacía`,
    );
  }

  if (pctCoefFuera > thresholds.avisoPctCoefFuera) {
    avisos.push(
      `Σ de coeficientes ≠ 100% en ${f1(pctCoefFuera)}% de parcelas. Esperable donde hay ` +
        `casas independientes sobre una misma parcela (cada bien lleva 100%). No aborta.`,
    );
  }
  if (s.rowsSinBienVivienda > 0) {
    avisos.push(
      `${s.rowsSinBienVivienda.toLocaleString("es-ES")} filas de uso VIVIENDA sin bien ` +
        `inmueble asignado, descartadas por ser elementos comunes.`,
    );
  }

  return {
    passed: errores.length === 0,
    errores,
    avisos,
    metricas: {
      "filas de construcción": s.rowsTotal.toLocaleString("es-ES"),
      "filas agrupadas en un bien ya visto": s.rowsAgrupadas.toLocaleString("es-ES"),
      "filas sin bien inmueble": `${s.rowsSinBien.toLocaleString("es-ES")} (${f1(pct(s.rowsSinBien, Math.max(1, s.rowsTotal)))}%)`,
      "  de ellas uso VIVIENDA": s.rowsSinBienVivienda.toLocaleString("es-ES"),
      "construida desde t15": `${s.construidaDeT15.toLocaleString("es-ES")} (${f1(pctCobertura)}%)`,
      "construida imputada por coeficiente": s.construidaImputadaPorCoef.toLocaleString("es-ES"),
      "construida sin dato (privativa)": s.construidaSinDato.toLocaleString("es-ES"),
      "construida descartada por ratio": `${s.construidaClampeada.toLocaleString("es-ES")} (${f2(pctRatioFuera)}%)`,
      "ratio medio construida/privativa": f2(ratioMedio),
      "Σconstruida ≉ priv+comunes": `${s.sumaParcelasFuera.toLocaleString("es-ES")} / ${s.sumaParcelas.toLocaleString("es-ES")} parcelas (${f1(pctSumaFuera)}%)`,
      "Σcoef ≠ 100% (solo aviso)": `${s.coefParcelasFuera.toLocaleString("es-ES")} / ${(s.coefParcelasOk + s.coefParcelasFuera).toLocaleString("es-ES")} parcelas (${f1(pctCoefFuera)}%)`,
    },
  };
}

export function printGateResult(r: GateResult): void {
  console.log("\n🚦 Gate de validación del layout:");
  for (const [k, v] of Object.entries(r.metricas)) {
    console.log(`  - ${k}: ${v}`);
  }
  for (const a of r.avisos) console.log(`  ⚠️  ${a}`);
  if (r.passed) {
    console.log("  ✅ PASA — el layout del fichero coincide con el verificado.");
  } else {
    console.log("  ❌ FALLA:");
    for (const e of r.errores) console.log(`     · ${e}`);
  }
}
