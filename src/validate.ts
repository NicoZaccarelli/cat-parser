import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    console.error("Faltan SUPABASE_URL / SUPABASE_SERVICE_KEY en .env");
    process.exit(1);
  }
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const fmt = (n: number | null | undefined) =>
    (n ?? 0).toLocaleString("es-ES");

  console.log("📊 Validación carga Supabase\n");

  const [bCount, tCount] = await Promise.all([
    client.from("buildings").select("*", { count: "exact", head: true }),
    client
      .from("building_typologies")
      .select("*", { count: "exact", head: true }),
  ]);

  console.log("1️⃣  SELECT COUNT(*) FROM buildings:");
  console.log(`    → ${fmt(bCount.count)}  (esperado 109.963)`);
  if (bCount.error) console.error(`    ⚠️  ${bCount.error.message}`);

  console.log("\n2️⃣  SELECT COUNT(*) FROM building_typologies:");
  console.log(`    → ${fmt(tCount.count)}  (esperado 582.499)`);
  if (tCount.error) console.error(`    ⚠️  ${tCount.error.message}`);

  console.log(
    "\n3️⃣  SELECT * FROM buildings_full WHERE parcel_ref = '3040203VK4734A':",
  );
  const testRef = "3040203VK4734A";
  const { data: testRows, error: testErr } = await client
    .from("buildings_full")
    .select("*")
    .eq("parcel_ref", testRef);
  if (testErr) {
    console.error(`    ⚠️  ${testErr.message}`);
  } else if (!testRows || testRows.length === 0) {
    console.log(`    ❌ No se encontró ${testRef}`);
  } else {
    printBuilding(testRows[0]);
  }

  console.log(
    "\n4️⃣  SELECT * FROM buildings_full WHERE total_units > 100 ORDER BY random() LIMIT 1:",
  );
  const { data: bigRows, error: bigErr } = await client.rpc("sample_big", {});
  if (bigErr && !bigErr.message.includes("sample_big")) {
    console.error(`    ⚠️  ${bigErr.message}`);
  }
  if (!bigRows) {
    const { data: candidates, error: cErr } = await client
      .from("buildings")
      .select("parcel_ref", { count: "exact" })
      .gt("total_units", 100)
      .limit(5000);
    if (cErr) {
      console.error(`    ⚠️  ${cErr.message}`);
    } else if (candidates && candidates.length > 0) {
      const pick =
        candidates[Math.floor(Math.random() * candidates.length)].parcel_ref;
      const { data: row, error } = await client
        .from("buildings_full")
        .select("*")
        .eq("parcel_ref", pick)
        .single();
      if (error) {
        console.error(`    ⚠️  ${error.message}`);
      } else if (row) {
        printBuilding(row);
      }
    } else {
      console.log("    (ningún edificio con total_units > 100)");
    }
  }

  console.log(
    "\n📚 Fuente: Dirección General del Catastro (datos elaborados).",
  );
}

function printBuilding(row: Record<string, unknown>): void {
  console.log(`    parcel_ref:  ${row.parcel_ref}`);
  console.log(`    address:     ${row.address}`);
  console.log(`    municipality: ${row.municipality}`);
  console.log(`    province:    ${row.province}`);
  console.log(`    year_built:  ${row.year_built ?? "n/d"}`);
  console.log(`    total_units: ${row.total_units}`);
  console.log(`    source_date: ${row.source_date}`);
  const typologies = (row.typologies as Array<Record<string, unknown>>) ?? [];
  console.log(`    typologies (${typologies.length}):`);
  for (const t of typologies) {
    console.log(
      `      · ${t.use_category} ${t.typology_name}: ${t.unit_count} u · ${t.m2_avg} m² (${t.m2_min}-${t.m2_max}) · plantas ${t.floors}`,
    );
  }
}

main().catch((err) => {
  console.error("Error fatal:", err);
  process.exit(1);
});
