import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

async function main() {
  const client = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const fmt = (n: number | null | undefined) =>
    (n ?? 0).toLocaleString("es-ES");

  console.log("📊 Validación final\n");

  console.log("1️⃣  SELECT COUNT(*) FROM buildings;");
  console.log("    SELECT COUNT(*) FROM building_typologies;");
  const [bCount, tCount] = await Promise.all([
    client.from("buildings").select("*", { count: "exact", head: true }),
    client
      .from("building_typologies")
      .select("*", { count: "exact", head: true }),
  ]);
  console.log(`    buildings            → ${fmt(bCount.count)}`);
  console.log(`    building_typologies  → ${fmt(tCount.count)}`);

  console.log(
    "\n2️⃣  SELECT * FROM buildings_full WHERE parcel_ref = '3040203VK4734A';",
  );
  const { data: rows, error } = await client
    .from("buildings_full")
    .select("*")
    .eq("parcel_ref", "3040203VK4734A");
  if (error) {
    console.error(`    ⚠️  ${error.message}`);
  } else if (!rows || rows.length === 0) {
    console.log("    ❌ No encontrado");
  } else {
    const row = rows[0] as Record<string, unknown>;
    console.log(`    parcel_ref:   ${row.parcel_ref}`);
    console.log(`    address:      ${row.address}`);
    console.log(`    municipality: ${row.municipality}`);
    console.log(`    province:     ${row.province}`);
    console.log(`    year_built:   ${row.year_built ?? "n/d"}`);
    console.log(`    total_units:  ${row.total_units}`);
    console.log(`    lat / lng:    ${row.lat ?? "null"} / ${row.lng ?? "null"}`);
    console.log(`    source_date:  ${row.source_date}`);
    console.log(`    loaded_at:    ${row.loaded_at}`);
    const typologies =
      (row.typologies as Array<Record<string, unknown>>) ?? [];
    console.log(`    typologies (${typologies.length}):`);
    for (const t of typologies) {
      console.log(
        `      · ${t.use_category} ${t.typology_name}: ${t.unit_count} u · ${t.m2_avg} m² (${t.m2_min}-${t.m2_max}) · plantas ${t.floors}`,
      );
    }
  }

  console.log(
    "\n3️⃣  SELECT COUNT(*) FROM building_typologies WHERE floors ~ '(OM|CC|EC|OD)';",
  );
  let total = 0;
  for (const code of ["OM", "CC", "EC", "OD"]) {
    const { count, error: err } = await client
      .from("building_typologies")
      .select("*", { count: "exact", head: true })
      .like("floors", `%${code}%`);
    if (err) {
      console.error(`    ⚠️  ${code}: ${err.message}`);
    } else {
      console.log(`    ${code}: ${fmt(count)}`);
      total += count ?? 0;
    }
  }
  const ok = total === 0 ? "✅" : "❌";
  console.log(`    TOTAL (OM|CC|EC|OD): ${fmt(total)}  (esperado 0)  ${ok}`);

  console.log(
    "\n📚 Fuente: Dirección General del Catastro — datos de 2026-01-23",
  );
}

main().catch((err) => {
  console.error("Error fatal:", err);
  process.exit(1);
});
