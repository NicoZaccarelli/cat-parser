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

  console.log("🔬 Validación post-prune\n");

  const [bCount, tCount] = await Promise.all([
    client.from("buildings").select("*", { count: "exact", head: true }),
    client
      .from("building_typologies")
      .select("*", { count: "exact", head: true }),
  ]);
  console.log("1️⃣  Counts:");
  console.log(
    `    buildings: ${fmt(bCount.count)}  (esperado 109.285)  ${bCount.count === 109285 ? "✅" : "❌"}`,
  );
  console.log(
    `    building_typologies: ${fmt(tCount.count)}  (esperado 531.896)  ${tCount.count === 531896 ? "✅" : "❌"}`,
  );

  console.log(
    "\n2️⃣  SELECT address, total_units FROM buildings WHERE parcel_ref = '3040203VK4734A':",
  );
  const { data: row } = await client
    .from("buildings")
    .select("address, total_units")
    .eq("parcel_ref", "3040203VK4734A")
    .single();
  console.log(`    address:     ${row?.address}`);
  console.log(`    total_units: ${row?.total_units}`);
  const ok1 = row?.address === "AV MENENDEZ PELAYO 67";
  const ok2 = row?.total_units && row.total_units >= 443 && row.total_units <= 444;
  console.log(
    `    Esperado "AV MENENDEZ PELAYO 67" + total_units 443-444: ${ok1 && ok2 ? "✅" : "❌"}`,
  );

  console.log(
    "\n3️⃣  SELECT COUNT(*) FROM building_typologies WHERE floors LIKE '%CC%':",
  );
  const { count: ccCount } = await client
    .from("building_typologies")
    .select("*", { count: "exact", head: true })
    .like("floors", "%CC%");
  console.log(
    `    → ${fmt(ccCount)}  (esperado 0)  ${ccCount === 0 ? "✅" : "❌"}`,
  );

  console.log(
    "\n4️⃣  SELECT COUNT(*) FROM building_typologies WHERE floors LIKE '%OM%':",
  );
  const { count: omCount } = await client
    .from("building_typologies")
    .select("*", { count: "exact", head: true })
    .like("floors", "%OM%");
  console.log(
    `    → ${fmt(omCount)}  (esperado 0)  ${omCount === 0 ? "✅" : "❌"}`,
  );

  console.log(
    "\n📚 Fuente: Dirección General del Catastro (datos elaborados).",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
