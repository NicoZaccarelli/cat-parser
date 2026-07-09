// Loader Navarra (Gobierno de Navarra) — entry point.
// Uso: npx tsx src/loader-navarra/index.ts <cod3> [--dry-run]
//   ej: npx tsx src/loader-navarra/index.ts 183 --dry-run    (Obanos)
//
// Estrategia:
//   1. Extraer del zip alfanumérico (LATIN-1): vias, unidades_urbanas, destinos.
//   2. Filtrar unidades con destino en NAV_EXCLUDE_DESTINOS (comunes/aux).
//   3. Agrupar unidades por (mun, pol, par) → Building.
//   4. Leer parcelas urbanas del gpkg (CATAST_Pol_ParcelaUrba) para geometrías.
//   5. Reproyectar 25830 → 4326 (helpers de bizkaia).
//   6. Tipologizar por use_category (uso + rango m² ±10%).
//   7. Upsert Supabase (source='NAV').

import * as fs from "node:fs";
import * as path from "node:path";
import * as iconv from "iconv-lite";
import * as unzipper from "unzipper";
import Database from "better-sqlite3";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

import type { Unit } from "../parser/types.js";
import {
  centroidOfPolygon25830,
  project25830To4326,
  ringsToMultiPolygonWKT,
} from "../loader-bizkaia/reproject.js";

import {
  mapNavDestino,
  NAV_EXCLUDE_DESTINOS,
  parseUnidadUrbana,
  parseVia,
  labelFromTipoVia,
  type UnidadUrbanaRaw,
  type ViaRow,
} from "./nav-mapping.js";

dotenv.config();

const ALFANUM_DIR = "E:/canScan/cat/Navarra/alfanumerico";
const GPKG = "E:/canScan/cat/Navarra/Catastro.gpkg";
const PARCELA_TABLE = "CATAST_Pol_ParcelaUrba — CATAST_Pol_ParcelaUrba.shp";
const SOURCE_DATE = "2026-02-12";
const SOURCE = "NAV" as const;
const PROVINCE = "Navarra";

interface Args {
  codMun: string;
  dryRun: boolean;
}
function parseArgs(argv: string[]): Args {
  const args = argv.slice(2);
  const pos = args.filter((a) => !a.startsWith("--"));
  const dryRun = args.includes("--dry-run");
  if (pos.length < 1) {
    console.error("Uso: npx tsx src/loader-navarra/index.ts <cod3> [--dry-run]");
    process.exit(1);
  }
  return { codMun: pos[0].padStart(3, "0"), dryRun };
}
function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
function toForalId(mun: string, pol: string, par: string): string {
  return `31-${mun.padStart(3, "0")}-${pol.padStart(2, "0")}-${par.padStart(4, "0")}`;
}
function titleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/(^|\s|-|\/|'|\.)(\p{L})/gu, (_m, sep, ch) => `${sep}${ch.toUpperCase()}`);
}

async function readTextFromZip(zipPath: string, entryName: string): Promise<string> {
  const zip = await unzipper.Open.file(zipPath);
  const entry = zip.files.find((f) => f.path === entryName);
  if (!entry) throw new Error(`Entrada no encontrada: ${entryName} en ${zipPath}`);
  const buf = await entry.buffer();
  return iconv.decode(buf, "latin1");
}

/* ─── Decodifica polígono GeoPackage WKB (soporta Polygon y MultiPolygon) ── */
function decodeGpkgGeometry(geom: Buffer): [number, number][][] {
  // Cabecera GP + envelope opcional + WKB estándar.
  if (geom.length < 8 || geom[0] !== 0x47 || geom[1] !== 0x50) return [];
  const flags = geom[3];
  const envType = (flags >> 1) & 0x07;
  let envBytes = 0;
  if (envType === 1) envBytes = 32;
  else if (envType === 2 || envType === 3) envBytes = 48;
  else if (envType === 4) envBytes = 64;
  const wkbStart = 8 + envBytes;
  if (geom.length < wkbStart + 9) return [];

  const wkbEndian = geom[wkbStart];
  const readU32 = (off: number) =>
    wkbEndian === 1 ? geom.readUInt32LE(off) : geom.readUInt32BE(off);
  const readDouble = (off: number) =>
    wkbEndian === 1 ? geom.readDoubleLE(off) : geom.readDoubleBE(off);

  const type = readU32(wkbStart + 1);
  const rings: [number, number][][] = [];

  const readPolygonAt = (start: number): number => {
    // start apunta al primer byte tras el `type` de un Polygon estándar
    // (o dentro de un MultiPolygon). Lee numRings + numPoints + puntos.
    // Devuelve el offset final.
    let off = start;
    const numRings = readU32(off);
    off += 4;
    // Solo capturamos el ring exterior (índice 0). Ignoramos rings internos.
    for (let r = 0; r < numRings; r++) {
      const numPoints = readU32(off);
      off += 4;
      if (r === 0) {
        const ring: [number, number][] = [];
        for (let i = 0; i < numPoints; i++) {
          ring.push([readDouble(off), readDouble(off + 8)]);
          off += 16;
        }
        rings.push(ring);
      } else {
        off += numPoints * 16;
      }
    }
    return off;
  };

  if (type === 3) {
    readPolygonAt(wkbStart + 5);
  } else if (type === 6) {
    // MultiPolygon: numPolygons, luego cada polygon con su header endian + tipo.
    let off = wkbStart + 5;
    const numPolys = readU32(off);
    off += 4;
    for (let p = 0; p < numPolys; p++) {
      // Cada polygon en MULTIPOLYGON WKB tiene su propio endian(1) + type(4) + rings.
      off += 5;
      off = readPolygonAt(off);
    }
  }
  return rings;
}

async function main() {
  const { codMun, dryRun } = parseArgs(process.argv);
  const zipPath = path.join(ALFANUM_DIR, `${codMun}_alfanumerico.zip`);
  if (!fs.existsSync(zipPath)) {
    console.error(`No existe: ${zipPath}`);
    process.exit(1);
  }
  console.log(`\n=== Navarra loader — municipio ${codMun} ${dryRun ? "[DRY-RUN]" : ""} ===`);
  const tStart = Date.now();

  // 1. vias.
  const viasText = await readTextFromZip(zipPath, `vias_${codMun}.txt`);
  const viaByCvia = new Map<string, ViaRow>();
  for (const line of viasText.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const v = parseVia(line);
    if (v) viaByCvia.set(v.cvia, v);
  }
  console.log(`Vías: ${viaByCvia.size}`);

  // 2. unidades_urbanas.
  const uuText = await readTextFromZip(zipPath, `unidades_urbanas_${codMun}.txt`);
  const uuLines = uuText.split(/\r?\n/).filter((l) => l.trim());
  console.log(`Unidades urbanas totales: ${uuLines.length}`);

  const excludeCounts = new Map<string, number>();
  const destinoCounts = new Map<string, number>();
  const unknownDestinos = new Set<string>();

  interface BuildingAgg {
    mun: string;
    pol: string;
    par: string;
    units: (Unit & { _navCategory: string })[];
    anoConstrMin: number | null;
    anoConstrMax: number | null;
    isTerreno: boolean; // hay al menos una unidad con destino=01
  }
  const buildingsByKey = new Map<string, BuildingAgg>();

  for (const line of uuLines) {
    const uu = parseUnidadUrbana(line);
    if (!uu) continue;

    // Contamos destino ANTES de filtrar para reporte.
    destinoCounts.set(uu.destino, (destinoCounts.get(uu.destino) ?? 0) + 1);

    if (NAV_EXCLUDE_DESTINOS.has(uu.destino)) {
      excludeCounts.set(uu.destino, (excludeCounts.get(uu.destino) ?? 0) + 1);
      continue;
    }

    const mapping = mapNavDestino(uu.destino);
    if (!mapping.wasKnown) unknownDestinos.add(uu.destino);

    // Superficie total = privativa + cerrada + abierta + comunes (excluye
    // solo elementos comunes puros ya filtrados). Redondeo a 1 decimal.
    // SupPrivativa suele ser el uso principal; sumamos las 4 para reflejar
    // superficie real construida.
    const superficie = uu.supPriv + uu.supCerr + uu.supAbi + uu.supCom;
    if (superficie <= 0) continue;

    const key = `${uu.mun}-${uu.pol}-${uu.par}`;
    let b = buildingsByKey.get(key);
    if (!b) {
      b = {
        mun: uu.mun,
        pol: uu.pol,
        par: uu.par,
        units: [],
        anoConstrMin: null,
        anoConstrMax: null,
        isTerreno: false,
      };
      buildingsByKey.set(key, b);
    }
    b.units.push({
      usoChar: uu.destino,
      planta: uu.planta.trim() || "?",
      superficie,
      _navCategory: mapping.category,
    } as Unit & { _navCategory: string });

    if (uu.anoConstr) {
      if (b.anoConstrMin === null || uu.anoConstr < b.anoConstrMin) b.anoConstrMin = uu.anoConstr;
      if (b.anoConstrMax === null || uu.anoConstr > b.anoConstrMax) b.anoConstrMax = uu.anoConstr;
    }
    if (mapping.isTerreno) b.isTerreno = true;
  }

  console.log(`Destinos únicos: ${destinoCounts.size}`);
  console.log(`Unidades excluidas por destino común: ${[...excludeCounts.values()].reduce((a, b) => a + b, 0)}`);
  console.log(`Buildings agrupados por parcela: ${buildingsByKey.size}`);
  if (unknownDestinos.size > 0) {
    console.log(`⚠ Destinos no en NAV_KNOWN_MAPPING: ${[...unknownDestinos].join(", ")}`);
  }

  // 3. Geometrías del gpkg.
  console.log(`\nLeyendo geometrías del gpkg (CMUNICIPIO=${parseInt(codMun, 10)})...`);
  const tGpkg = Date.now();
  const db = new Database(GPKG, { readonly: true });
  const rows = db
    .prepare(`SELECT POLIGONO, PARCELA, geom FROM "${PARCELA_TABLE}" WHERE CMUNICIPIO = ?`)
    .all(parseInt(codMun, 10)) as Array<{
      POLIGONO: number;
      PARCELA: number;
      geom: Buffer;
    }>;
  db.close();
  console.log(`  gpkg parcels: ${rows.length}  (took ${Date.now() - tGpkg}ms)`);
  interface ParcelaGeom {
    lat: number;
    lng: number;
    wkt: string;
  }
  const parcelByKey = new Map<string, ParcelaGeom>();
  for (const r of rows) {
    const rings = decodeGpkgGeometry(r.geom);
    if (rings.length === 0) continue;
    // Usamos el ring del primer polygon (exterior) para centroide.
    const [cx, cy] = centroidOfPolygon25830(rings[0]);
    const [lng, lat] = project25830To4326(cx, cy);
    const posLists = rings.map((ring) => ring.map(([x, y]) => `${x} ${y}`).join(" "));
    const wkt = ringsToMultiPolygonWKT(posLists);
    const pol = String(r.POLIGONO).padStart(2, "0");
    const par = String(r.PARCELA).padStart(4, "0");
    parcelByKey.set(`${codMun}-${pol}-${par}`, { lat, lng, wkt });
  }

  // 4. Compose rows.
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

  // Necesitamos el nombre del municipio y una dirección primaria.
  // Obtenemos el municipality del primer registro que tenga MUNICIPIO en el gpkg.
  const dbMun = new Database(GPKG, { readonly: true });
  const munRow = dbMun
    .prepare(`SELECT MUNICIPIO FROM "${PARCELA_TABLE}" WHERE CMUNICIPIO = ? LIMIT 1`)
    .get(parseInt(codMun, 10)) as { MUNICIPIO?: string } | undefined;
  dbMun.close();
  const municipality = munRow?.MUNICIPIO?.trim() || `NAVARRA-${codMun}`;

  let buildingsWithGeom = 0,
    missingGeom = 0;
  for (const [key, b] of buildingsByKey.entries()) {
    const foralId = toForalId(b.mun, b.pol, b.par);
    const parcel = parcelByKey.get(key);
    if (parcel) buildingsWithGeom++;
    else missingGeom++;

    // Dirección primaria: vías del municipio son a nivel calle, no
    // disponibles a nivel parcela sin join adicional. Usamos etiqueta
    // "{Municipio} · Polígono {P} Parcela {N}" como fallback consistente.
    const address = `${titleCase(municipality)} · Polígono ${parseInt(b.pol, 10)} Parcela ${parseInt(b.par, 10)}`;

    // total_units = viviendas (destino='04').
    const totalViviendas = b.units.filter((u) => u.usoChar === "04").length;
    // Año construcción: usamos el máximo (último año registrado — refleja
    // reformas recientes si aplican).
    const year =
      b.anoConstrMax ??
      b.anoConstrMin ??
      null;

    rowsToUpsert.push({
      parcel_ref: foralId,
      address,
      municipality,
      province: PROVINCE,
      year_built: year,
      total_units: totalViviendas,
      lat: parcel?.lat ?? null,
      lng: parcel?.lng ?? null,
      source_date: SOURCE_DATE,
      source: SOURCE,
    });

    // Tipologías agrupadas por _navCategory.
    const porCategoria: Record<string, Unit[]> = {};
    for (const u of b.units) {
      const cat = (u as any)._navCategory as string;
      (porCategoria[cat] ??= []).push(u);
    }
    for (const [cat, units] of Object.entries(porCategoria)) {
      const tipos = generarTipologiasSimple(units);
      for (const t of tipos) {
        typologyRows.push({
          parcel_ref: foralId,
          use_category: cat,
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
        municipality,
        geom: `SRID=4326;${parcel.wkt}`,
      });
    }
  }

  console.log(`\n--- Resumen composición ---`);
  console.log(`  Buildings totales: ${rowsToUpsert.length}`);
  console.log(`  Tipologías: ${typologyRows.length}`);
  console.log(`  Con geometría gpkg: ${buildingsWithGeom}`);
  console.log(`  SIN geometría gpkg: ${missingGeom}`);
  console.log(`  Municipio: ${municipality}`);
  console.log(`  Tiempo elapsed: ${((Date.now() - tStart) / 1000).toFixed(1)}s`);

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

  console.log(`\n=== Cargando a Supabase (source='NAV') ===`);
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
    if (error) console.warn(`  ⚠ geom batch: ${error.message}`);
    else geomOk += batch.length;
  }
  console.log(`  parcel_geometries: ${geomOk}/${geomRows.length} upserted`);

  console.log(
    `\n${rowsToUpsert.length} edificios cargados, ${typologyRows.length} tipologías cargadas`,
  );
}

// ─── Tipologizer minimal (mismo criterio ±10% rango que Bizkaia/Gipuzkoa) ───
function generarTipologiasSimple(
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
  const out: Array<{
    nombre: string;
    m2Medio: number;
    m2Min: number;
    m2Max: number;
    numUnidades: number;
    plantas: string[];
  }> = [];
  let group: Unit[] = [];
  const flush = () => {
    if (!group.length) return;
    const sup = group.map((u) => u.superficie);
    const min = Math.min(...sup);
    const max = Math.max(...sup);
    const media = sup.reduce((s, v) => s + v, 0) / sup.length;
    out.push({
      nombre: letra(out.length),
      m2Medio: media,
      m2Min: min,
      m2Max: max,
      numUnidades: group.length,
      plantas: [...new Set(group.map((u) => u.planta).filter(Boolean))].sort(),
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
    if ((max - min) / media <= TOLERANCIA * 2) group.push(u);
    else {
      flush();
      group.push(u);
    }
  }
  flush();
  return out;
}
function letra(idx: number): string {
  const c = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  if (idx < c.length) return c[idx];
  return `${c[Math.floor(idx / c.length) - 1]}${c[idx % c.length]}`;
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
