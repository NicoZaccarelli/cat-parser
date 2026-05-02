// count-affected.ts
// Cuantifica buildings afectados por cachedBuildingIsSmallResidential (<3 viviendas).
// Usa batches .in() para reducir queries: ~20 batches × 100 refs por provincia.
// Cálculos idénticos a la propuesta original del user.

import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";

const envPath = path.join(process.cwd(), ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf-8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!,
  { auth: { persistSession: false } },
);

const SAMPLE_SIZE = 2000;
const BATCH_IN_SIZE = 100;

async function analyzeProvince(provincia: string) {
  console.log(`\n=== ${provincia} ===`);

  const { count: totalBuildings } = await supabase
    .from("buildings")
    .select("*", { count: "exact", head: true })
    .eq("province", provincia);

  console.log(`Total buildings: ${totalBuildings}`);

  const muestreo = Math.min(SAMPLE_SIZE, totalBuildings ?? 0);
  if (muestreo === 0) return;

  const { data: buildings } = await supabase
    .from("buildings")
    .select("parcel_ref")
    .eq("province", provincia)
    .limit(muestreo);

  if (!buildings) return;
  const parcelRefs = buildings.map((b) => (b as { parcel_ref: string }).parcel_ref);

  // Batched .in() queries to fetch all typologies for the sample
  const typologiesByParcel: Record<string, Array<{ use_category: string; unit_count: number }>> = {};
  for (let i = 0; i < parcelRefs.length; i += BATCH_IN_SIZE) {
    const batch = parcelRefs.slice(i, i + BATCH_IN_SIZE);
    const { data: typs, error } = await supabase
      .from("building_typologies")
      .select("parcel_ref, use_category, unit_count")
      .in("parcel_ref", batch);
    if (error) throw error;
    for (const t of typs ?? []) {
      const ref = (t as { parcel_ref: string }).parcel_ref;
      if (!typologiesByParcel[ref]) typologiesByParcel[ref] = [];
      typologiesByParcel[ref].push({
        use_category: (t as { use_category: string }).use_category,
        unit_count: (t as { unit_count: number }).unit_count,
      });
    }
  }

  let afectados = 0;
  let conMultiplesInmuebles = 0;
  let unifamiliares = 0;
  let ceroTypologies = 0;

  for (const ref of parcelRefs) {
    const typs = typologiesByParcel[ref] ?? [];
    if (typs.length === 0) {
      ceroTypologies++;
      continue;
    }
    const totalViviendas = typs
      .filter((t) => t.use_category.toLowerCase().includes("vivienda"))
      .reduce((s, t) => s + t.unit_count, 0);
    const totalInmuebles = typs.reduce((s, t) => s + t.unit_count, 0);
    if (totalViviendas < 3) {
      afectados++;
      if (totalInmuebles > 1) conMultiplesInmuebles++;
      if (totalInmuebles === 1) unifamiliares++;
    }
  }

  const pctAfectados = ((afectados / muestreo) * 100).toFixed(1);
  const estimadoTotal = Math.round((afectados / muestreo) * (totalBuildings ?? 0));

  console.log(`Muestreo: ${muestreo}`);
  console.log(`Afectados (<3 viviendas): ${afectados} (${pctAfectados}%)`);
  console.log(`  - Con multiples inmuebles (Plan B podria rescatar): ${conMultiplesInmuebles}`);
  console.log(`  - Unifamiliares reales (1 inmueble; no es bug): ${unifamiliares}`);
  console.log(`  - Ni viviendas ni anexos (intermedios): ${afectados - conMultiplesInmuebles - unifamiliares}`);
  console.log(`  - Buildings con cero typologies en sample: ${ceroTypologies}`);
  console.log(`Estimacion total ${provincia}: ~${estimadoTotal.toLocaleString("es-ES")} buildings afectados`);
}

async function main() {
  console.log("=== Buildings afectados por cachedBuildingIsSmallResidential ===");
  console.log("Sample size por provincia: " + SAMPLE_SIZE);

  for (const p of ["Baleares", "Madrid", "Valencia", "Barcelona", "Sevilla"]) {
    await analyzeProvince(p);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
