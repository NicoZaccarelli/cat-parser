// Snapshot post-carga Bizkaia (Fase 1 foral).
// Reporta totales BFA, no-regresión DGC, y sample.
import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
dotenv.config();

const s = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

async function main() {
  console.log("=== SNAPSHOT BIZKAIA (post-batch 113 municipios) ===\n");

  // 1. Totales por source
  const { count: bfaCount } = await s
    .from("buildings")
    .select("*", { count: "exact", head: true })
    .eq("source", "BFA");
  const { count: dgcCount } = await s
    .from("buildings")
    .select("*", { count: "exact", head: true })
    .eq("source", "DGC");
  console.log(`buildings source='BFA': ${bfaCount?.toLocaleString("es-ES")} (esperado 88.482)`);
  console.log(`buildings source='DGC': ${dgcCount?.toLocaleString("es-ES")} (esperado 6.701.289 — sin cambio)`);

  // 2. Typologies BFA
  const { count: typoBfaCount } = await s
    .from("building_typologies")
    .select("*", { count: "exact", head: true })
    .gte("parcel_ref", "48-")
    .lt("parcel_ref", "48/");
  console.log(`building_typologies BFA: ${typoBfaCount?.toLocaleString("es-ES")} (esperado 436.377)`);

  // 3. parcel_geometries BFA
  const { count: geoCount } = await s
    .from("parcel_geometries")
    .select("*", { count: "exact", head: true })
    .eq("source", "BFA");
  console.log(`parcel_geometries source='BFA': ${geoCount?.toLocaleString("es-ES")} (esperado 88.482)`);

  // 4. Municipios distintos
  const { data: municipios } = await s
    .from("buildings")
    .select("municipality")
    .eq("source", "BFA")
    .limit(5000);
  const uniqueMuns = new Set((municipios ?? []).map((r) => r.municipality));
  console.log(`municipios distintos BFA: ${uniqueMuns.size} (esperado 113)`);

  // 5. Top 5 municipios por buildings
  const { data: allBfa } = await s
    .from("buildings")
    .select("municipality, total_units")
    .eq("source", "BFA")
    .limit(100000);
  const counts = new Map<string, { count: number; units: number }>();
  for (const r of allBfa ?? []) {
    const c = counts.get(r.municipality) || { count: 0, units: 0 };
    c.count++;
    c.units += r.total_units;
    counts.set(r.municipality, c);
  }
  const top = [...counts.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 10);
  console.log(`\nTop 10 municipios por edificios BFA:`);
  for (const [mun, { count, units }] of top) {
    console.log(`  ${mun.padEnd(30)}  edificios=${count.toString().padStart(6)}  viviendas=${units.toString().padStart(7)}`);
  }

  // 6a. Validar fix total_units: los 3 unifamiliares deben tener total_units=2 ahora.
  console.log(`\nValidación fix total_units (esperado 2 en los 3 unifamiliares):`);
  for (const ref of ["48-001-0001-00015-1-1", "48-001-0001-00083-1-1", "48-001-0001-00094-1-1"]) {
    const { data } = await s.from("buildings").select("total_units, address").eq("parcel_ref", ref).maybeSingle();
    console.log(`  ${ref}: total_units=${data?.total_units}  ${data?.address}`);
  }

  // 6b. Sample: Abadiño building conocido
  const { data: abadino } = await s
    .from("buildings_full")
    .select("*")
    .eq("parcel_ref", "48-001-1012-01001-1-1")
    .maybeSingle();
  console.log(`\nSample Abadiño (control 48-001-1012-01001-1-1):`);
  if (abadino) {
    console.log(`  address: ${abadino.address}`);
    console.log(`  municipality: ${abadino.municipality}`);
    console.log(`  year_built: ${abadino.year_built}  total_units: ${abadino.total_units}`);
    console.log(`  lat/lng: ${abadino.lat}, ${abadino.lng}`);
    console.log(`  source: ${abadino.source}`);
    console.log(`  typologies: ${(abadino.typologies as any[])?.length ?? 0}`);
  } else {
    console.log(`  NO ENCONTRADO`);
  }

  // 7. Verificar Bilbao (municipio grande)
  const { count: bilbaoCount } = await s
    .from("buildings")
    .select("*", { count: "exact", head: true })
    .gte("parcel_ref", "48-020-")
    .lt("parcel_ref", "48-021-");
  console.log(`\nbuildings Bilbao (48-020-*): ${bilbaoCount?.toLocaleString("es-ES")}`);

  // 8. RPC test — centroide de control
  const { data: rpcData } = await s.rpc("find_parcel_by_point", {
    lat: 43.168437,
    lng: -2.612035,
  });
  console.log(`\nRPC find_parcel_by_point(control):`);
  console.log(`  → ${JSON.stringify(rpcData?.[0])}`);
}

main().catch((e) => {
  console.error("SNAPSHOT ERROR:", e);
  process.exit(1);
});
