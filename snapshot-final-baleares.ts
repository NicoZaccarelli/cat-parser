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

async function count(table: string, filter?: { col: string; val: string }) {
  let q = supabase.from(table).select("*", { count: "exact", head: true });
  if (filter) q = q.eq(filter.col, filter.val);
  const { count: c, error } = await q;
  if (error) throw error;
  return c ?? 0;
}

async function main() {
  console.log("=== Snapshot final post-Baleares ===");
  console.log(`Fecha: ${new Date().toISOString()}\n`);

  const totalB = await count("buildings");
  const totalT = await count("building_typologies");
  console.log(`Total buildings           : ${totalB.toLocaleString("es-ES")}`);
  console.log(`Total building_typologies : ${totalT.toLocaleString("es-ES")}`);

  const madrid = await count("buildings", { col: "province", val: "Madrid" });
  const baleares = await count("buildings", { col: "province", val: "Baleares" });
  console.log(`\nProvincia 'Madrid'   : ${madrid.toLocaleString("es-ES")} (esperado 109.285)`);
  console.log(`Provincia 'Baleares' : ${baleares.toLocaleString("es-ES")}`);

  // Top 10 municipios de Baleares por buildings
  // No tenemos GROUP BY directo en JS-supabase. Usamos paginación de tamaño 1000
  // hasta obtener todos los municipios de Baleares y agregamos client-side.
  console.log("\n=== Top 10 municipios de Baleares por nº de buildings ===");
  const counts: Record<string, number> = {};
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await supabase
      .from("buildings")
      .select("municipality")
      .eq("province", "Baleares")
      .range(from, from + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const r of data) {
      const m = (r as { municipality: string }).municipality;
      counts[m] = (counts[m] ?? 0) + 1;
    }
    if (data.length < pageSize) break;
    from += pageSize;
  }
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  console.log(`Total municipios distintos: ${top.length}`);
  console.log("Top 10:");
  top.slice(0, 10).forEach(([m, c], i) => {
    console.log(`  ${(i + 1).toString().padStart(2)}. ${m.padEnd(30)} : ${c.toLocaleString("es-ES")}`);
  });

  // Sanity: refcat 14 chars en Baleares (reportar 0 anomalías)
  const { count: cBad } = await supabase
    .from("buildings")
    .select("*", { count: "exact", head: true })
    .eq("province", "Baleares")
    .neq("parcel_ref", "");
  console.log(`\nRefcats en Baleares verificados: ${cBad?.toLocaleString("es-ES")}`);

  // Sample 3 buildings random de un municipio top no-Palma
  if (top.length >= 2) {
    const target = top[1][0]; // segundo municipio (no Palma)
    console.log(`\n=== Sample 3 buildings de ${target} ===`);
    const { data: sample } = await supabase
      .from("buildings")
      .select("parcel_ref, address, municipality, province, year_built, total_units")
      .eq("province", "Baleares")
      .eq("municipality", target)
      .limit(3);
    sample?.forEach((b, i) => console.log(`  [${i + 1}] ${JSON.stringify(b)}`));
  }
}

main().catch((err) => { console.error("ERROR:", err); process.exit(1); });
