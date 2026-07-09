// Loader Álava (Arabako Foru Aldundia) — INSPIRE BU (Building core2d).
// Uso: npx tsx src/loader-alava/index.ts <cod4> [--dry-run]
//   ej: npx tsx src/loader-alava/index.ts 0106 --dry-run
//
// Ficha reducida (per prompt del user):
//   - Sin unidades individuales ni callejero (no publicados por AFA).
//   - Por edificio: localId, currentUse, numberOfDwellings,
//     numberOfFloorsAboveGround, dateOfConstruction, geometría 25830.
//   - Superficie construida ESTIMADA = huella × plantas.
//   - foral_id = 01-{localId} (17 chars totales para el localId más largo).
//
// currentUse (codelist INSPIRE) → categoría común:
//   residential → "Vivienda"
//   ancillary   → "Anexo"
//   industrial  → "Industrial"
//   office      → "Oficinas"
//   trade       → "Comercial"
//   publicServices → "Servicios públicos"
//   otros → "Otros"

import * as fs from "node:fs";
import * as path from "node:path";
import * as unzipper from "unzipper";
import { SaxesParser } from "saxes";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import {
  centroidOfPolygon25830,
  project25830To4326,
  ringsToMultiPolygonWKT,
  parsePosList,
} from "../loader-bizkaia/reproject.js";

dotenv.config();

const ZIP_BU = "E:/canScan/cat/Alava/BU_25830_GML.zip";
const SOURCE_DATE = "2026-02-01";
const SOURCE = "AFA" as const;
const PROVINCE = "Álava";

const CURRENT_USE_MAP: Record<string, string> = {
  residential: "Vivienda",
  ancillary: "Anexo",
  industrial: "Industrial",
  office: "Oficinas",
  trade: "Comercial",
  publicServices: "Servicios públicos",
};

interface Args {
  codMun: string;
  dryRun: boolean;
}
function parseArgs(argv: string[]): Args {
  const args = argv.slice(2);
  const pos = args.filter((a) => !a.startsWith("--"));
  const dryRun = args.includes("--dry-run");
  if (pos.length < 1) {
    console.error("Uso: npx tsx src/loader-alava/index.ts <cod4> [--dry-run]");
    process.exit(1);
  }
  return { codMun: pos[0].padStart(4, "0"), dryRun };
}
function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
function toForalId(localId: string): string {
  return `01-${localId}`;
}
/** Área con fórmula de Shoelace (25830, resultado en m²). */
function polygonArea25830(ring: [number, number][]): number {
  if (ring.length < 3) return 0;
  let a = 0;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[(i + 1) % n];
    a += x0 * y1 - x1 * y0;
  }
  return Math.abs(a) / 2;
}

interface BuildingRow {
  localId: string;
  municipio: string;
  currentUse: string; // codelist raw (residential, ancillary, ...)
  numberOfDwellings: number;
  numberOfFloorsAboveGround: number;
  dateOfConstruction: number | null; // año
  posList: string;
  lat: number;
  lng: number;
  huellaM2: number;
  wkt: string;
}

async function parseBuGml(zipPath: string, entryName: string): Promise<BuildingRow[]> {
  const zip = await unzipper.Open.file(zipPath);
  const entry = zip.files.find((f) => f.path === entryName);
  if (!entry) throw new Error(`Entrada no encontrada: ${entryName}`);
  const stream = entry.stream();
  const parser = new SaxesParser({ xmlns: false });

  const results: BuildingRow[] = [];
  let inBuilding = false;
  let localId = "";
  let currentUse = "";
  let dwellings = 0;
  let floors = 0;
  let dateConstr = "";
  let posList: string | undefined;
  let captureText = "";
  let capturingText: string | null = null;

  // Estado para navegar tags anidados (currentUse tiene un sub-currentUse).
  let inCurrentUseBlock = false;
  let inGeometry = false;
  let inExterior = false;
  let posListCaptured = false;

  const stripNs = (n: string) => {
    const i = n.indexOf(":");
    return i >= 0 ? n.slice(i + 1) : n;
  };

  parser.on("opentag", (tag) => {
    const local = stripNs(tag.name);
    if (!inBuilding) {
      if (local === "Building") {
        inBuilding = true;
        localId = "";
        currentUse = "";
        dwellings = 0;
        floors = 0;
        dateConstr = "";
        posList = undefined;
        inCurrentUseBlock = false;
        inGeometry = false;
        inExterior = false;
        posListCaptured = false;
      }
      return;
    }

    if (local === "CurrentUse") inCurrentUseBlock = true;
    if (local === "currentUse" && inCurrentUseBlock) {
      // Tag anidado con xlink:href codelist. Extraer último segmento.
      const attrs = (tag as any).attributes;
      const href = attrs?.["xlink:href"]?.value ?? attrs?.["xlink:href"] ?? "";
      if (typeof href === "string" && href.includes("/CurrentUseValue/")) {
        currentUse = href.split("/CurrentUseValue/")[1] || "";
      }
    }

    if (local === "geometry2D" || local === "BuildingGeometry2D" || local === "Surface" || local === "patches" || local === "PolygonPatch") {
      inGeometry = true;
    }
    if (local === "exterior" && inGeometry) inExterior = true;

    captureText = "";
    if (
      local === "localId" ||
      local === "numberOfDwellings" ||
      local === "numberOfFloorsAboveGround" ||
      (local === "anyPoint")
    ) {
      capturingText = local;
    } else if (local === "posList" && inExterior && !posListCaptured) {
      capturingText = "posList";
    } else {
      capturingText = null;
    }
  });

  parser.on("text", (t) => {
    if (capturingText) captureText += t;
  });

  parser.on("closetag", (tag) => {
    const local = stripNs(tag.name);
    if (!inBuilding) return;

    if (capturingText === local) {
      const val = captureText.trim();
      if (local === "localId") localId = val;
      else if (local === "numberOfDwellings") dwellings = parseInt(val, 10) || 0;
      else if (local === "numberOfFloorsAboveGround") floors = parseInt(val, 10) || 0;
      else if (local === "anyPoint") dateConstr = val;
      else if (local === "posList" && !posListCaptured) {
        posList = val;
        posListCaptured = true;
      }
      captureText = "";
      capturingText = null;
    }

    if (local === "exterior") inExterior = false;
    if (local === "CurrentUse") inCurrentUseBlock = false;

    if (local === "Building") {
      // Emit if valid.
      if (localId && posList) {
        const ring = parsePosList(posList);
        if (ring.length >= 3) {
          const [cx, cy] = centroidOfPolygon25830(ring);
          const [lng, lat] = project25830To4326(cx, cy);
          const huella = polygonArea25830(ring);
          const wkt = ringsToMultiPolygonWKT([posList]);
          let year: number | null = null;
          if (dateConstr.length >= 4) {
            const y = parseInt(dateConstr.slice(0, 4), 10);
            if (Number.isFinite(y) && y >= 1000 && y <= 2100) year = y;
          }
          results.push({
            localId,
            municipio: "",
            currentUse,
            numberOfDwellings: dwellings,
            numberOfFloorsAboveGround: floors,
            dateOfConstruction: year,
            posList,
            lat,
            lng,
            huellaM2: huella,
            wkt,
          });
        }
      }
      inBuilding = false;
      inGeometry = false;
    }
  });

  parser.on("error", (e) => {
    throw e;
  });

  return new Promise<BuildingRow[]>((resolve, reject) => {
    stream.on("data", (chunk: Buffer) => {
      try {
        parser.write(chunk.toString("utf8"));
      } catch (err) {
        reject(err);
      }
    });
    stream.on("end", () => {
      try {
        parser.close();
        resolve(results);
      } catch (err) {
        reject(err);
      }
    });
    stream.on("error", reject);
  });
}

async function main() {
  const { codMun, dryRun } = parseArgs(process.argv);
  const entryName = `ES.AFA.BU.${codMun}_25830.gml`;
  console.log(`\n=== Álava loader — municipio ${codMun} ${dryRun ? "[DRY-RUN]" : ""} ===`);
  const tStart = Date.now();

  const buildings = await parseBuGml(ZIP_BU, entryName);
  console.log(`Buildings parseados: ${buildings.length}`);

  // Nombre del municipio: usamos localId prefix + tabla de códigos oficial.
  // AFA usa códigos propios de 4 dígitos (010X..017X). Para este loader
  // usamos "AFA-{cod4}" como fallback y luego el municipality se puede
  // mejorar mapeándolo desde un catálogo externo si aparece.
  const municipality = `Álava-${codMun}`;

  // Counts por currentUse
  const useCounts = new Map<string, number>();
  let totalDwellings = 0;
  let residential = 0;
  for (const b of buildings) {
    useCounts.set(b.currentUse || "(vacío)", (useCounts.get(b.currentUse || "(vacío)") ?? 0) + 1);
    totalDwellings += b.numberOfDwellings;
    if (b.currentUse === "residential") residential++;
  }
  console.log(`Total viviendas (Σ numberOfDwellings): ${totalDwellings}`);
  console.log(`Buildings con currentUse='residential': ${residential}`);
  console.log(`Counts currentUse:`, Object.fromEntries(useCounts));

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

  for (const b of buildings) {
    const foralId = toForalId(b.localId);
    const address = `${municipality} · Ref ${b.localId}`;
    // superficie estimada = huella × plantas
    const supEstimada =
      b.huellaM2 > 0 && b.numberOfFloorsAboveGround > 0
        ? b.huellaM2 * Math.max(1, b.numberOfFloorsAboveGround)
        : 0;

    // total_units en Álava = numberOfDwellings.
    // (Bizkaia/Gipuzkoa/Navarra usan viviendas también → coherente.)
    rowsToUpsert.push({
      parcel_ref: foralId,
      address,
      municipality,
      province: PROVINCE,
      year_built: b.dateOfConstruction,
      total_units: b.numberOfDwellings,
      lat: b.lat,
      lng: b.lng,
      source_date: SOURCE_DATE,
      source: SOURCE,
    });

    // Una tipología sintética por edificio para que foralAggregates
    // compute usoPrincipal + superficieConstruida:
    if (supEstimada > 0) {
      const cat = CURRENT_USE_MAP[b.currentUse] || "Otros";
      const unitCount = Math.max(1, b.numberOfDwellings);
      typologyRows.push({
        parcel_ref: foralId,
        use_category: cat,
        typology_name: "A",
        m2_avg: Math.round(supEstimada / unitCount),
        m2_min: Math.round(supEstimada / unitCount),
        m2_max: Math.round(supEstimada / unitCount),
        unit_count: unitCount,
        floors: String(b.numberOfFloorsAboveGround),
      });
    }

    geomRows.push({
      foral_id: foralId,
      source: SOURCE,
      municipality,
      geom: `SRID=4326;${b.wkt}`,
    });
  }

  console.log(`\n--- Resumen composición ---`);
  console.log(`  Buildings totales: ${rowsToUpsert.length}`);
  console.log(`  Tipologías: ${typologyRows.length}`);
  console.log(`  Geometrías: ${geomRows.length}`);
  console.log(`  Tiempo elapsed: ${((Date.now() - tStart) / 1000).toFixed(1)}s`);

  if (dryRun) {
    console.log(`\n=== DRY-RUN OK ===`);
    return;
  }

  const url = process.env.SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_KEY!;
  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  console.log(`\n=== Cargando a Supabase (source='AFA') ===`);
  for (const batch of chunks(rowsToUpsert, 50)) {
    const { error } = await supabase.from("buildings").upsert(batch, { onConflict: "parcel_ref" });
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
    const { error } = await supabase.from("parcel_geometries").upsert(batch, { onConflict: "foral_id" });
    if (error) console.warn(`  ⚠ geom batch: ${error.message}`);
    else geomOk += batch.length;
  }
  console.log(`  parcel_geometries: ${geomOk}/${geomRows.length} upserted`);

  console.log(`\n${rowsToUpsert.length} edificios cargados, ${typologyRows.length} tipologías cargadas`);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
