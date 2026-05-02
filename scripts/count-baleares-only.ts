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

async function main() {
  const provincia = "Baleares";
  console.log(`=== ${provincia} (re-run) ===`);

  // Try without count first; we know it's 190984
  const totalBuildings = 190984;
  console.log(`Total buildings (conocido de snapshots previos): ${totalBuildings}`);

  const { data: buildings } = await supabase
    .from("buildings")
    .select("parcel_ref")
    .eq("province", provincia)
    .limit(SAMPLE_SIZE);

  if (!buildings || buildings.length === 0) {
    console.log("ERROR: no buildings devueltos");
    return;
  }
  console.log(`Buildings descargados: ${buildings.length}`);
  const parcelRefs = buildings.map((b) => (b as { parcel_ref: string }).parcel_ref);

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

  const pctAfectados = ((afectados / buildings.length) * 100).toFixed(1);
  const estimadoTotal = Math.round((afectados / buildings.length) * totalBuildings);

  console.log(`Muestreo: ${buildings.length}`);
  console.log(`Afectados (<3 viviendas): ${afectados} (${pctAfectados}%)`);
  console.log(`  - Con multiples inmuebles (Plan B podria rescatar): ${conMultiplesInmuebles}`);
  console.log(`  - Unifamiliares reales (1 inmueble; no es bug): ${unifamiliares}`);
  console.log(`  - Intermedios: ${afectados - conMultiplesInmuebles - unifamiliares}`);
  console.log(`  - Buildings con cero typologies en sample: ${ceroTypologies}`);
  console.log(`Estimacion total Baleares: ~${estimadoTotal.toLocaleString("es-ES")} buildings afectados`);
}

main().catch((e) => { console.error(e); process.exit(1); });
