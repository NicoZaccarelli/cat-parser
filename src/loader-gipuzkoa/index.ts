// Loader Gipuzkoa (GFA) — entry point.
// Uso: npx tsx src/loader-gipuzkoa/index.ts <MUNICIPIO> [--dry-run]
//   ej: npx tsx src/loader-gipuzkoa/index.ts ADUNA --dry-run
//       npx tsx src/loader-gipuzkoa/index.ts "DONOSTIA-SAN SEBASTIAN" --dry-run
//
// Composición:
//   1. Carga CSVs alfanuméricos del municipio: locales (unidades) +
//      parcelas y unidades constructivas (año construcción).
//   2. Filtra Om='EC' (elementos comunes).
//   3. Agrupa por Referen (referencia parcela) → construye Building con
//      units[]; mapea De → use_category via gfa-mapping.
//   4. Añade año construcción desde CSV de parcelas.
//   5. Lee gpkg CP para geometrías + centroide (lat/lng).
//   6. Reusa tipologizarEdificio → tipologías.
//   7. Si --dry-run: imprime cifras y sale. Sino: upsert Supabase.

import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

import { tipologizarEdificio } from "../transformer/typologizer.js";
import type { Building, Unit } from "../parser/types.js";

import {
  streamCsvGroup,
  streamCsv,
  parseGfaSuperficie,
  parseGfaFecha,
  type CsvRow,
} from "./csv-stream.js";
import {
  mapGfaDestino,
  GFA_OM_EXCLUDE,
  GFA_UNKNOWN_CODES,
  GFA_KNOWN_MAPPING,
  type GfaMappingWarning,
} from "./gfa-mapping.js";
import { readParcels, type ParcelRow } from "./gpkg-parcels.js";

dotenv.config();

const ALFANUMERICO_DIR = "E:/canScan/cat/Gipuzkoa/alfanumerico";
const GPKG_CP = "E:/canScan/cat/Gipuzkoa/GFA_INSPIRE_CP.gpkg";
const SOURCE_DATE = "2026-07-04";
const SOURCE = "GFA" as const;
const PROVINCE = "Gipuzkoa";

interface Args {
  municipio: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const args = argv.slice(2);
  const positional = args.filter((a) => !a.startsWith("--"));
  const dryRun = args.includes("--dry-run");
  if (positional.length < 1) {
    console.error(
      "Uso: npx tsx src/loader-gipuzkoa/index.ts <MUNICIPIO> [--dry-run]",
    );
    process.exit(1);
  }
  return { municipio: positional.join(" "), dryRun };
}

function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function toForalId(mun: string, referen: string): string {
  return `20-${mun.padStart(3, "0")}-${referen}`;
}

async function main() {
  const { municipio, dryRun } = parseArgs(process.argv);

  const munDir = path.join(ALFANUMERICO_DIR, municipio);
  if (!fs.existsSync(munDir)) {
    console.error(`No existe la carpeta del municipio: ${munDir}`);
    process.exit(1);
  }

  console.log(`\n=== Gipuzkoa GFA loader — ${municipio} ${dryRun ? "[DRY-RUN]" : ""} ===`);

  const tStart = Date.now();

  // 1. Listar ficheros CSV del municipio.
  const files = fs.readdirSync(munDir);
  const localesFiles = files
    .filter((f) => /^Datos de los locales(-\d+)?\.csv$/i.test(f))
    .sort()
    .map((f) => path.join(munDir, f));
  const parcelasFile = files.find(
    (f) => /^Datos de parcelas y unidades constructivas\.csv$/i.test(f),
  );
  console.log(
    `CSVs locales: ${localesFiles.length} (${localesFiles.map((f) => path.basename(f)).join(", ")})`,
  );
  console.log(`CSV parcelas: ${parcelasFile ?? "(missing)"}`);
  if (localesFiles.length === 0 || !parcelasFile) {
    console.error("Faltan ficheros CSV. Abortando.");
    process.exit(1);
  }

  // 2. Cargar CSV parcelas → mapa referen → año construcción.
  const yearByReferen = new Map<string, number | null>();
  let parcelasCsvCount = 0;
  await streamCsv(path.join(munDir, parcelasFile), (row) => {
    parcelasCsvCount++;
    const referen = (row.Refer ?? "").trim();
    if (!referen) return;
    const year = parseGfaFecha(row.FeFinObr ?? "");
    yearByReferen.set(referen, year);
  });
  console.log(`Parcelas (filas CSV): ${parcelasCsvCount}`);

  // 3. Cargar CSVs de locales → agrupar por referen.
  let totalLocales = 0;
  let excludedEC = 0;
  const unitsByReferen = new Map<string, Unit[]>();
  const dCounts = new Map<string, number>();  // De counts para reporte
  const omCounts = new Map<string, number>(); // Om counts
  const unknownCodes = new Map<string, number>(); // "Desconocido" seguimiento
  let municipalityCsv = "";
  let munCode = ""; // "004", "069", etc.
  const referenAddress = new Map<string, string>(); // primera vez que aparece

  await streamCsvGroup(localesFiles, (row) => {
    totalLocales++;
    const om = (row.Om ?? "").trim().toUpperCase();
    omCounts.set(om, (omCounts.get(om) ?? 0) + 1);
    if (GFA_OM_EXCLUDE.has(om)) {
      excludedEC++;
      return;
    }
    const de = (row.De ?? "").trim();
    dCounts.set(de, (dCounts.get(de) ?? 0) + 1);

    const referen = (row.Referen ?? "").trim();
    if (!referen) return;
    if (!munCode) munCode = (row.Mun ?? "").trim().padStart(3, "0");

    const mapping = mapGfaDestino(de);
    if (!mapping.wasKnown) {
      unknownCodes.set(de, (unknownCodes.get(de) ?? 0) + 1);
    }
    // Nota: por contrato con foralAggregates.ts, "Vivienda" debe ser el
    // string exacto. `mapGfaDestino` lo garantiza para De='V'.
    const usoCategory = mapping.category;

    const superficie = parseGfaSuperficie(row["Superfic."] ?? "");
    if (superficie <= 0) return;

    // Construimos un Unit con usoChar del char inicial de la categoría
    // que tipologizarEdificio espera. IMPORTANTE: tipologizarEdificio
    // usa `classifyUso(u.usoChar)` que devuelve la categoría DE NUEVO
    // desde USO_CATEGORIAS. Para forzar la categoría GFA correcta, hacemos
    // trick: guardamos la categoría en el usoChar de forma que classifyUso
    // devuelva lo mismo. Actually mejor: parcheamos el Unit para llevar la
    // categoría ya calculada.
    // Solución: pasamos usoChar = primera letra del código GFA original
    // (V, P, T...) y AÑADIMOS un typologizer con el mapping GFA.
    // → NO: usamos un typologizer específico para GFA que respete la
    // categoría del mapping. Ver más abajo.
    const usoChar = de.trim().charAt(0).toUpperCase() || "?";
    const planta = (row.Pl ?? "").trim();
    const unit: Unit = { usoChar, planta, superficie };
    // Guardamos también la categoría GFA para que el typologizer local
    // pueda usarla en vez del USO_CATEGORIAS del DGC. La añadimos como
    // propiedad extra en el objeto — TypeScript la aceptará vía cast.
    (unit as any)._gfaCategory = usoCategory;

    const list = unitsByReferen.get(referen) ?? [];
    list.push(unit);
    unitsByReferen.set(referen, list);

    // Guardar primera dirección vista para la parcela.
    if (!referenAddress.has(referen)) {
      const via = (row["Descripción Vía"] ?? "").trim();
      const npor = (row.Npor ?? "").trim().replace(/^0+/, "") || "0";
      if (via) {
        referenAddress.set(
          referen,
          `${titleCase(via)}, ${npor.replace(/[^0-9A-Z]/gi, "")}`,
        );
      }
    }
    if (!municipalityCsv) municipalityCsv = municipio;
  });

  console.log(`Locales (filas CSV): ${totalLocales}`);
  console.log(`Excluidas Om='EC': ${excludedEC}`);
  console.log(`Buildings agrupados por Referen: ${unitsByReferen.size}`);
  console.log(`Municipio código GFA: ${munCode}`);
  console.log("De counts:");
  const deSorted = [...dCounts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [k, v] of deSorted.slice(0, 20)) console.log(`  ${k || "(vacío)"} = ${v}`);

  if (unknownCodes.size > 0) {
    console.log("\n⚠ Códigos GFA DESCONOCIDOS (no en KNOWN ni en UNKNOWN):");
    for (const [k, v] of unknownCodes.entries())
      console.log(`  "${k}" x ${v}  → mapeados a "Desconocido"`);
  }

  // 4. Cargar geometrías del municipio del gpkg.
  console.log(`\nLeyendo geometrías gpkg CP (mun=${munCode})...`);
  const tGpkg = Date.now();
  const parcels = readParcels(GPKG_CP, munCode);
  console.log(
    `  gpkg parcels: ${parcels.length}  (took ${Date.now() - tGpkg}ms)`,
  );
  const parcelByReferen = new Map<string, ParcelRow>();
  for (const p of parcels) parcelByReferen.set(p.referen, p);

  // 5. Construir Buildings + agregar tipologías.
  // Usamos un typologizer local que respeta _gfaCategory en vez de
  // classifyUso() del pipeline DGC.
  const buildings: Building[] = [];
  const rowsToUpsert: Array<{
    parcel_ref: string;
    address: string;
    municipality: string;
    province: string;
    year_built: number | null;
    total_units: number;
    lat: number | null;
    lng: number | null;
    source_date: string;
    source: string;
  }> = [];
  const typologyRows: Array<{
    parcel_ref: string;
    use_category: string;
    typology_name: string;
    m2_avg: number;
    m2_min: number;
    m2_max: number;
    unit_count: number;
    floors: string;
  }> = [];
  const geomRows: Array<{
    foral_id: string;
    source: string;
    municipality: string;
    geom: string;
  }> = [];

  let buildingsWithGeom = 0;
  let buildingsMissingGeom = 0;

  for (const [referen, units] of unitsByReferen.entries()) {
    const foralId = toForalId(munCode, referen);
    const parcel = parcelByReferen.get(referen);
    const year = yearByReferen.get(referen) ?? null;
    const address = referenAddress.get(referen) ?? `${municipalityCsv} (sin dirección)`;
    const totalViviendas = units.filter((u) => (u as any)._gfaCategory === "Vivienda").length;

    // Tipologías: reusamos tipologizarEdificio pero SUSTITUYENDO
    // temporalmente classifyUso. Solución más simple: agrupamos units
    // manualmente por _gfaCategory (mismo criterio) y usamos generarTipologias.
    // Como el typologizer de cat-parser es un módulo cerrado, replicamos
    // la lógica mínima: agrupar por categoría GFA + generar tipologías
    // usando el helper interno del propio pipeline via tipologizarEdificio
    // con un adaptador (parche del usoChar → categoría GFA).
    // Aquí lo hacemos con un mini-agrupador local (más simple y robusto):
    const typosPorUso = agruparTipologiasPorUsoGfa(units);

    rowsToUpsert.push({
      parcel_ref: foralId,
      address,
      municipality: municipalityCsv,
      province: PROVINCE,
      year_built: year,
      total_units: totalViviendas,
      lat: parcel?.lat ?? null,
      lng: parcel?.lng ?? null,
      source_date: SOURCE_DATE,
      source: SOURCE,
    });

    for (const [uso, tipologias] of Object.entries(typosPorUso)) {
      for (const t of tipologias) {
        typologyRows.push({
          parcel_ref: foralId,
          use_category: uso,
          typology_name: t.nombre,
          m2_avg: Math.round(t.m2Medio),
          m2_min: Math.round(t.m2Min),
          m2_max: Math.round(t.m2Max),
          unit_count: t.numUnidades,
          floors: t.plantas.join(","),
        });
      }
    }

    if (parcel) {
      geomRows.push({
        foral_id: foralId,
        source: SOURCE,
        municipality: municipalityCsv,
        geom: `SRID=4326;${parcel.wkt}`,
      });
      buildingsWithGeom++;
    } else {
      buildingsMissingGeom++;
    }
  }

  console.log(`\n--- Resumen composición ---`);
  console.log(`  Buildings totales: ${rowsToUpsert.length}`);
  console.log(`  Tipologías: ${typologyRows.length}`);
  console.log(`  Con geometría gpkg: ${buildingsWithGeom}`);
  console.log(`  SIN geometría gpkg: ${buildingsMissingGeom}`);

  console.log(`\n  Tiempo elapsed: ${((Date.now() - tStart) / 1000).toFixed(1)}s`);

  if (dryRun) {
    console.log(`\n=== DRY-RUN OK ===`);
    return;
  }

  // Upsert real.
  const url = process.env.SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_KEY!;
  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  console.log(`\n=== Cargando a Supabase (source='GFA') ===`);
  for (const batch of chunks(rowsToUpsert, 50)) {
    const { error } = await supabase.from("buildings").upsert(batch, {
      onConflict: "parcel_ref",
    });
    if (error) throw new Error(`upsert buildings: ${error.message}`);
  }
  console.log(`  buildings: ${rowsToUpsert.length} upserted`);

  const parcelRefs = rowsToUpsert.map((r) => r.parcel_ref);
  for (const c of chunks(parcelRefs, 500)) {
    await supabase.from("building_typologies").delete().in("parcel_ref", c);
  }
  for (const batch of chunks(typologyRows, 50)) {
    const { error } = await supabase.from("building_typologies").insert(batch);
    if (error) throw new Error(`insert typologies: ${error.message}`);
  }
  console.log(`  building_typologies: ${typologyRows.length} inserted`);

  let geomOk = 0;
  for (const batch of chunks(geomRows, 50)) {
    const { error } = await supabase.from("parcel_geometries").upsert(batch, {
      onConflict: "foral_id",
    });
    if (error) console.warn(`  ⚠ upsert geom batch failed: ${error.message}`);
    else geomOk += batch.length;
  }
  console.log(`  parcel_geometries: ${geomOk}/${geomRows.length} upserted`);

  console.log(
    `\n${rowsToUpsert.length} edificios cargados, ${typologyRows.length} tipologías cargadas`,
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/(^|\s|-|\/|'|\.)(\p{L})/gu, (_m, sep, ch) => `${sep}${ch.toUpperCase()}`);
}

/**
 * Agrupa units GFA por _gfaCategory (mapeada desde De) y genera tipologías
 * dentro de cada categoría con ancho de banda de superficie ±10% (mismo
 * criterio que el typologizer DGC/BFA). Excluye units con planta anómala.
 */
function agruparTipologiasPorUsoGfa(units: Unit[]): Record<
  string,
  Array<{
    nombre: string;
    m2Medio: number;
    m2Min: number;
    m2Max: number;
    numUnidades: number;
    plantas: string[];
  }>
> {
  const porUso: Record<string, Unit[]> = {};
  for (const u of units) {
    const cat = (u as any)._gfaCategory as string;
    if (!cat) continue;
    // Excluir units con superficie <= 0 ya está garantizado en el reader.
    (porUso[cat] ??= []).push(u);
  }

  const out: Record<string, ReturnType<typeof generarTipologiasGfa>> = {};
  for (const [cat, us] of Object.entries(porUso)) {
    out[cat] = generarTipologiasGfa(us);
  }
  return out;
}

/**
 * Implementación local (independiente de USO_CATEGORIAS del DGC) de la
 * generación de tipologías con banda ±10% del rango sobre la media.
 * Igual criterio numérico que src/transformer/typologizer.ts.
 */
function generarTipologiasGfa(
  units: Unit[],
): Array<{
  nombre: string;
  m2Medio: number;
  m2Min: number;
  m2Max: number;
  numUnidades: number;
  plantas: string[];
}> {
  if (units.length === 0) return [];
  const TOLERANCIA = 0.05;
  const sorted = units.slice().sort((a, b) => a.superficie - b.superficie);
  const tipologias: Array<{
    nombre: string;
    m2Medio: number;
    m2Min: number;
    m2Max: number;
    numUnidades: number;
    plantas: string[];
  }> = [];
  let group: Unit[] = [];
  const flush = () => {
    if (group.length === 0) return;
    const sup = group.map((u) => u.superficie);
    const min = Math.min(...sup);
    const max = Math.max(...sup);
    const media = sup.reduce((s, v) => s + v, 0) / sup.length;
    const plantasSet = new Set(group.map((u) => u.planta).filter(Boolean));
    tipologias.push({
      nombre: letra(tipologias.length),
      m2Medio: media,
      m2Min: min,
      m2Max: max,
      numUnidades: group.length,
      plantas: [...plantasSet].sort(),
    });
    group = [];
  };
  for (const u of sorted) {
    if (group.length === 0) {
      group.push(u);
      continue;
    }
    const sup = group.map((g) => g.superficie).concat(u.superficie);
    const min = Math.min(...sup);
    const max = Math.max(...sup);
    const media = sup.reduce((s, v) => s + v, 0) / sup.length;
    if ((max - min) / media <= TOLERANCIA * 2) {
      group.push(u);
    } else {
      flush();
      group.push(u);
    }
  }
  flush();
  return tipologias;
}

function letra(idx: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  if (idx < chars.length) return chars[idx];
  return `${chars[Math.floor(idx / chars.length) - 1]}${chars[idx % chars.length]}`;
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
