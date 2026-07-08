// Loader Bizkaia — entry point.
// Uso: npx tsx src/loader-bizkaia/index.ts <cod3> [--dry-run]
//   ej: npx tsx src/loader-bizkaia/index.ts 001 --dry-run
//
// Composición:
//   1. Callejero AD → Map<localId, {tipo, nombre, portal}>
//   2. Stream Edificio → Map<key, EdificioProps>
//   3. Stream Elemento → agrupa units por key
//   4. Compose Buildings + geometries
//   5. Tipologizar (typologizer compartido de cat-parser)
//   6. Si --dry-run: imprime cifras y sale. Sino: upsert en Supabase.
//
// Clave de agrupación (validada contra cifras Abadiño):
//   `mun-pol-par-sub-edi` → 735 buildings en Abadiño (471 ≥3viv + 264 1-2viv)
// foral_id publicado: `48-{mun3}-{pol4}-{par5}-{sub}-{edi}`

import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

import { tipologizarEdificio, totalTipologias } from "../transformer/typologizer.js";
import type { Building, Unit } from "../parser/types.js";
import { streamGmlFromZip } from "./gml-stream.js";
import {
  loadCallejero,
  buildLocalId,
  formatDireccion,
  type CallejeroEntry,
} from "./ad-callejero.js";
import { normalizePlanta, isViviendaUso } from "./bfa-mapping.js";
import { centroidWGS84, ringsToMultiPolygonWKT } from "./reproject.js";

dotenv.config();

const CATASTRO_DIR = "E:/canScan/cat/Bizkaia/catastro";
const CALLEJERO_DIR = "E:/canScan/cat/Bizkaia/callejero";
const SOURCE_DATE = "2026-07-02"; // fecha de descarga; misma para todos los municipios de Bizkaia
const SOURCE = "BFA" as const;

interface EdificioProps {
  attrs: Record<string, string>;
  posList?: string;
}

interface Args {
  codMun: string; // "001"
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const args = argv.slice(2);
  const posArgs = args.filter((a) => !a.startsWith("--"));
  const dryRun = args.includes("--dry-run");
  if (posArgs.length < 1) {
    console.error("Uso: npx tsx src/loader-bizkaia/index.ts <cod3> [--dry-run]");
    process.exit(1);
  }
  const codMun = posArgs[0].padStart(3, "0");
  return { codMun, dryRun };
}

function findCatastroZip(codMun: string): { zipPath: string; municipality: string } {
  const files = fs.readdirSync(CATASTRO_DIR);
  const target = files.find((f) => f.startsWith(`${codMun}_`) && f.endsWith(".zip"));
  if (!target) {
    throw new Error(`No hay zip catastro para código ${codMun} en ${CATASTRO_DIR}`);
  }
  // Formato: "001_ABADINO_GML_20260702.zip" → municipality = "ABADINO"
  const parts = target.split("_");
  const municipality = parts.length >= 2 ? parts[1].replace(/-/g, " ") : "?";
  return { zipPath: path.join(CATASTRO_DIR, target), municipality };
}

function findCallejeroZip(codMun: string): string | null {
  const p = path.join(CALLEJERO_DIR, `ES.BFA.AD.${codMun}.zip`);
  return fs.existsSync(p) ? p : null;
}

function toBuildingKey(a: Record<string, string>): string {
  const mun = (a.Codigo_Mun || "").trim().padStart(3, "0");
  const pol = (a.Codigo_Pol || "").trim().padStart(4, "0");
  const par = (a.Codigo_Par || "").trim().padStart(5, "0");
  const sub = (a.Codigo_Sub || "").trim() || "0";
  const edi = (a.Codigo_Edi || "").trim() || "0";
  return `${mun}-${pol}-${par}-${sub}-${edi}`;
}

function toForalId(key: string): string {
  return `48-${key}`;
}

async function main() {
  const { codMun, dryRun } = parseArgs(process.argv);

  const { zipPath, municipality } = findCatastroZip(codMun);
  const callejeroZip = findCallejeroZip(codMun);

  console.log(`\n=== Bizkaia loader — ${municipality} (${codMun}) ${dryRun ? "[DRY-RUN]" : ""} ===`);
  console.log(`Catastro: ${zipPath}`);
  console.log(`Callejero: ${callejeroZip || "MISSING (edificios sin dirección)"}`);

  const tStart = Date.now();

  // 1. Callejero.
  const callejero: Map<string, CallejeroEntry> = callejeroZip
    ? await loadCallejero(callejeroZip)
    : new Map();
  console.log(`Callejero cargado: ${callejero.size} portales`);

  // 2. Edificios.
  const edificios = new Map<string, EdificioProps>();
  const edificioTag = `_${codMun}_Edificio`;
  const edificioFile = `${codMun}_Edificio.gml`;
  await streamGmlFromZip(zipPath, edificioFile, edificioTag, (f) => {
    edificios.set(toBuildingKey(f.attrs), { attrs: f.attrs, posList: f.posList });
  });
  const edificiosUsoV = [...edificios.values()].filter(
    (e) => (e.attrs.Codigo_Uso || "").trim().toUpperCase() === "V",
  ).length;
  console.log(
    `Capa Edificio: ${edificios.size} filas (${edificiosUsoV} uso V)`,
  );

  // 3. Elementos → units.
  const unitsMap = new Map<string, Unit[]>();
  const elementoTag = `_${codMun}_Elemento`;
  const elementoFile = `${codMun}_Elemento.gml`;
  let elementoCount = 0,
    viviendaCount = 0;
  await streamGmlFromZip(zipPath, elementoFile, elementoTag, (f) => {
    elementoCount++;
    const key = toBuildingKey(f.attrs);
    const usoRaw = (f.attrs.Codigo_Uso || "").trim();
    const usoChar = usoRaw.charAt(0).toUpperCase();
    if (isViviendaUso(usoRaw)) viviendaCount++;
    const superficie = parseFloat(f.attrs.Superficie || "0");
    const planta = normalizePlanta(f.attrs.Codigo_Pla || "");
    if (!Number.isFinite(superficie) || superficie <= 0) return;
    const list = unitsMap.get(key);
    const unit: Unit = { usoChar, planta, superficie };
    if (list) list.push(unit);
    else unitsMap.set(key, [unit]);
  });
  console.log(
    `Capa Elemento: ${elementoCount} filas, ${viviendaCount} viviendas (uso V)`,
  );

  // 4. Compose Buildings.
  const buildings: Building[] = [];
  const geometries: Array<{ foralId: string; wkt: string }> = [];
  const foralIdByKey = new Map<string, string>();
  let ge3 = 0,
    eq12 = 0,
    skipped = 0,
    noAddress = 0;

  for (const [key, edi] of edificios.entries()) {
    const units = unitsMap.get(key) || [];
    const numViviendas = units.filter((u) => u.usoChar === "V").length;
    if (numViviendas === 0) {
      skipped++;
      continue;
    }
    if (numViviendas >= 3) ge3++;
    else eq12++;

    const foralId = toForalId(key);
    foralIdByKey.set(key, foralId);

    const localId = buildLocalId(
      edi.attrs.Codigo_Mun || "",
      edi.attrs.Codigo_Cal || "",
      edi.attrs.Numero_Por || "",
      edi.attrs.Duplicado_ || "",
    );
    const callejeroEntry = callejero.get(localId);
    const direccion = callejeroEntry ? formatDireccion(callejeroEntry) : "";
    if (!direccion) noAddress++;

    const anoConstrRaw = parseInt(edi.attrs.Ano_Constr || "", 10);
    const anoRehabRaw = parseInt(edi.attrs.Ano_Rehabi || "", 10);
    let anoConstruccion: number | null = null;
    if (Number.isFinite(anoConstrRaw) && anoConstrRaw > 1000) {
      anoConstruccion = anoConstrRaw;
    }
    if (
      Number.isFinite(anoRehabRaw) &&
      anoRehabRaw > 1000 &&
      (anoConstruccion === null || anoRehabRaw > anoConstruccion)
    ) {
      anoConstruccion = anoRehabRaw;
    }

    buildings.push({
      refcatParcela: foralId,
      direccion,
      numero: "",
      municipio: municipality,
      provincia: "Bizkaia",
      codigoPostal: "",
      anoConstruccion,
      units,
    });

    if (edi.posList) {
      geometries.push({ foralId, wkt: ringsToMultiPolygonWKT([edi.posList]) });
    }
  }

  // Callejero: nº de calles únicas (tipoVia + nombreVia normalizado).
  const callesUnicas = new Set<string>();
  for (const e of callejero.values()) {
    callesUnicas.add(`${e.tipoVia}|${e.nombreVia}`);
  }

  console.log(`\n--- Resultado composición ---`);
  console.log(`  Buildings totales: ${buildings.length}`);
  console.log(`    ≥3 viviendas: ${ge3}`);
  console.log(`    1-2 viviendas: ${eq12}`);
  console.log(`  Edificios uso V sin viviendas útiles (skipped): ${skipped}`);
  console.log(`  Buildings sin dirección en callejero: ${noAddress}`);
  console.log(`  Geometrías edificio (25830→4326): ${geometries.length}`);
  console.log(`  Calles únicas: ${callesUnicas.size}`);

  // Centroide de control (Abadiño): Pol 1012, Par 1001 → (43.168437, -2.612035)
  if (codMun === "001") {
    const controlKey = "001-1012-01001-1-1";
    const foralIdCtrl = toForalId(controlKey);
    const g = geometries.find((x) => x.foralId === foralIdCtrl);
    const edCtrl = edificios.get(controlKey);
    if (edCtrl?.posList) {
      const c = centroidWGS84(edCtrl.posList);
      console.log(
        `  Centroide control Ed 1012/1001 (esperado 43.168437, -2.612035):`,
        c,
      );
    } else {
      console.log(`  ⚠ Centroide control NO encontrado con clave ${controlKey}`);
    }
  }

  // 5. Tipologías.
  const buildingsRows: Array<{
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

  for (const b of buildings) {
    const bt = tipologizarEdificio(b);
    // Reencontrar posList/edi para lat/lng.
    const key = b.refcatParcela.slice(3); // quita "48-"
    const edi = edificios.get(key);
    let lat: number | null = null,
      lng: number | null = null;
    if (edi?.posList) {
      try {
        const c = centroidWGS84(edi.posList);
        lat = c.lat;
        lng = c.lng;
      } catch {
        // ignorar
      }
    }

    // total_units = viviendas (Codigo_Uso='V'), NO todas las units.
    // La app usa unidadesRC = cb.totalUnits para detectPropertyType con la regla
    // `< 3 → UNIFAMILIAR`. Si contamos anexos (almacenes, garajes) el conteo
    // pasa de 2 viviendas + 3 anexos = 5 → clasificaría como PLURIFAMILIAR.
    // Coherente con la semántica esperada de "número de viviendas del edificio".
    const totalViviendas = b.units.filter((u) => u.usoChar === "V").length;

    buildingsRows.push({
      parcel_ref: b.refcatParcela,
      address: b.direccion || `${b.municipio} (sin dirección)`,
      municipality: b.municipio,
      province: b.provincia,
      year_built: b.anoConstruccion,
      total_units: totalViviendas,
      lat,
      lng,
      source_date: SOURCE_DATE,
      source: SOURCE,
    });

    for (const [uso, tipologias] of Object.entries(bt.porUso)) {
      for (const t of tipologias) {
        typologyRows.push({
          parcel_ref: b.refcatParcela,
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
  }

  const totalTip = typologyRows.length;
  console.log(`  Tipologías generadas: ${totalTip}`);
  console.log(`  Tiempo elapsed: ${((Date.now() - tStart) / 1000).toFixed(1)}s`);

  // 6. DRY-RUN → salir. Real → upsert.
  if (dryRun) {
    console.log(`\n=== DRY-RUN OK ===`);
    console.log(`Sin escribir a Supabase.`);
    return;
  }

  // Carga real.
  const url = process.env.SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_KEY!;
  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  console.log(`\n=== Cargando a Supabase (source='BFA') ===`);

  // 6a. Upsert buildings en batches de 50.
  await upsertInBatches(supabase, "buildings", buildingsRows, 50, "parcel_ref");
  console.log(`  buildings: ${buildingsRows.length} upserted`);

  // 6b. Delete typologies previas + insert.
  const parcelRefs = buildingsRows.map((r) => r.parcel_ref);
  for (const chunk of chunks(parcelRefs, 500)) {
    await supabase.from("building_typologies").delete().in("parcel_ref", chunk);
  }
  await insertInBatches(supabase, "building_typologies", typologyRows, 50);
  console.log(`  building_typologies: ${typologyRows.length} inserted`);

  // 6c. Upsert parcel_geometries usando EWKT (SRID=4326;MULTIPOLYGON(...)).
  // PostGIS acepta EWKT string en columnas geometry via cast implícito.
  const geomRows = geometries.map((g) => ({
    foral_id: g.foralId,
    source: SOURCE,
    municipality,
    geom: `SRID=4326;${g.wkt}`,
  }));
  let geomInserted = 0;
  for (const batch of chunks(geomRows, 50)) {
    const { error } = await supabase
      .from("parcel_geometries")
      .upsert(batch, { onConflict: "foral_id" });
    if (error) {
      console.warn(`  ⚠ upsert geom batch failed: ${error.message}`);
    } else {
      geomInserted += batch.length;
    }
  }
  console.log(`  parcel_geometries: ${geomInserted}/${geometries.length} upserted`);

  console.log(`\n=== Carga OK ===`);
  console.log(
    `${buildingsRows.length} edificios cargados, ${typologyRows.length} tipologías cargadas`,
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function upsertInBatches(
  supabase: any,
  table: string,
  rows: any[],
  batchSize: number,
  onConflict: string,
): Promise<void> {
  for (const batch of chunks(rows, batchSize)) {
    const { error } = await supabase.from(table).upsert(batch, { onConflict });
    if (error) {
      throw new Error(`upsert ${table} failed: ${error.message}`);
    }
  }
}

async function insertInBatches(
  supabase: any,
  table: string,
  rows: any[],
  batchSize: number,
): Promise<void> {
  for (const batch of chunks(rows, batchSize)) {
    const { error } = await supabase.from(table).insert(batch);
    if (error) throw new Error(`insert ${table} failed: ${error.message}`);
  }
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
