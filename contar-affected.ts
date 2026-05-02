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
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!, { auth: { persistSession: false } });

async function main() {
  console.log("=== Análisis: buildings Baleares afectados por cachedBuildingIsSmallResidential ===\n");

  // 1. Total buildings Baleares
  const { count: totalBaleares } = await supabase
    .from("buildings")
    .select("*", { count: "exact", head: true })
    .eq("province", "Baleares");
  console.log(`Total buildings Baleares: ${totalBaleares}`);

  // 2. Necesitamos para CADA building sumar unit_count de typologies con
  // use_category que incluya "vivienda". Lo hacemos por paginación de
  // building_typologies (más eficiente: una sola query agregada client-side).

  console.log("\nDescargando typologies de Baleares (esto puede tardar)...");
  const allTypologies: Array<{ parcel_ref: string; use_category: string; unit_count: number }> = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await supabase
      .from("building_typologies")
      .select("parcel_ref, use_category, unit_count, buildings!inner(province)")
      .eq("buildings.province", "Baleares")
      .range(from, from + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const r of data) {
      allTypologies.push({
        parcel_ref: r.parcel_ref as string,
        use_category: r.use_category as string,
        unit_count: r.unit_count as number,
      });
    }
    process.stdout.write(`  ... ${allTypologies.length} typologies\r`);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  console.log(`\n  Total typologies Baleares: ${allTypologies.length}`);

  // 3. Agregación: sumar unit_count por parcel_ref para typologies con vivienda
  const totalViviendasPorParcel: Record<string, number> = {};
  const totalInmueblesPorParcel: Record<string, number> = {}; // total typologies (cualquier uso)
  const totalUnitsPorParcel: Record<string, number> = {}; // suma de unit_count en cualquier categoría
  for (const t of allTypologies) {
    if (!totalInmueblesPorParcel[t.parcel_ref]) totalInmueblesPorParcel[t.parcel_ref] = 0;
    totalInmueblesPorParcel[t.parcel_ref] += 1;
    if (!totalUnitsPorParcel[t.parcel_ref]) totalUnitsPorParcel[t.parcel_ref] = 0;
    totalUnitsPorParcel[t.parcel_ref] += t.unit_count;
    if (t.use_category.toLowerCase().includes("vivienda")) {
      if (!totalViviendasPorParcel[t.parcel_ref]) totalViviendasPorParcel[t.parcel_ref] = 0;
      totalViviendasPorParcel[t.parcel_ref] += t.unit_count;
    }
  }

  // 4. Para cada building, calcular si es small residential (<3 viviendas)
  const buildingsConSmallRes: string[] = [];
  const buildingsConCero: string[] = [];
  const buildingsConSuficientesViviendas: string[] = [];

  // También necesitamos los buildings sin ninguna typology vivienda
  // (totalViviendasPorParcel no los incluye). Para eso paginamos buildings.
  let bFrom = 0;
  let bCount = 0;
  while (true) {
    const { data, error } = await supabase
      .from("buildings")
      .select("parcel_ref")
      .eq("province", "Baleares")
      .range(bFrom, bFrom + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const b of data) {
      bCount++;
      const ref = (b as { parcel_ref: string }).parcel_ref;
      const totalViv = totalViviendasPorParcel[ref] ?? 0;
      if (totalViv === 0) buildingsConCero.push(ref);
      else if (totalViv < 3) buildingsConSmallRes.push(ref);
      else buildingsConSuficientesViviendas.push(ref);
    }
    if (data.length < pageSize) break;
    bFrom += pageSize;
  }

  console.log(`\n--- Distribución buildings Baleares por totalViviendas ---`);
  console.log(`  totalViviendas == 0          : ${buildingsConCero.length}`);
  console.log(`  totalViviendas in [1, 2]     : ${buildingsConSmallRes.length}  ← afectados por cachedBuildingIsSmallResidential`);
  console.log(`  totalViviendas >= 3          : ${buildingsConSuficientesViviendas.length}`);
  console.log(`  TOTAL                        : ${bCount}`);

  const afectadosTotal = buildingsConCero.length + buildingsConSmallRes.length;
  console.log(`\n  Buildings afectados (<3 viviendas): ${afectadosTotal} de ${bCount} (${(afectadosTotal / bCount * 100).toFixed(1)}%)`);

  // 5. De los afectados, ¿cuántos tienen N>1 inmuebles totales?
  // (esos son los que Plan B con DNPRC 2-pasos podría rescatar — porque
  // DNPRC con 14 chars devuelve <lrcdnp> con N rcdnp, no <bico> directo).
  let afectadosConN1 = 0;
  let afectadosConNmayor1 = 0;
  for (const ref of [...buildingsConCero, ...buildingsConSmallRes]) {
    const totalInm = totalInmueblesPorParcel[ref] ?? 0;
    if (totalInm <= 1) afectadosConN1++;
    else afectadosConNmayor1++;
  }

  console.log(`\n--- De los ${afectadosTotal} afectados, distribución por nº de typologies ---`);
  console.log(`  con 1 typology (probable <bico>) : ${afectadosConN1}  ← Plan B no aporta (DNPRC ya devuelve datos)`);
  console.log(`  con ≥2 typologies (probable <lrcdnp>) : ${afectadosConNmayor1}  ← Plan B podría rescatar`);

  // 6. Sample de algunos casos para verificar
  console.log(`\n--- Sample 5 buildings con totalViviendas ∈ [1,2] ---`);
  const samples = buildingsConSmallRes.slice(0, 5);
  for (const ref of samples) {
    const { data } = await supabase
      .from("buildings")
      .select("parcel_ref, address, municipality, total_units")
      .eq("parcel_ref", ref)
      .maybeSingle();
    const inm = totalInmueblesPorParcel[ref];
    const viv = totalViviendasPorParcel[ref];
    console.log(`  ${ref} | typologies=${inm} | viviendas=${viv} | total_units=${(data as { total_units?: number })?.total_units} | ${(data as { address?: string })?.address}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
