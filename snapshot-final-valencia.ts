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
  console.log("=== Snapshot final Valencia (post V5) ===");
  console.log(`Fecha: ${new Date().toISOString()}\n`);

  const totalB = await count("buildings");
  const totalT = await count("building_typologies");
  console.log(`Total buildings           : ${totalB.toLocaleString("es-ES")}`);
  console.log(`Total building_typologies : ${totalT.toLocaleString("es-ES")}`);

  const madrid = await count("buildings", { col: "province", val: "Madrid" });
  const baleares = await count("buildings", { col: "province", val: "Baleares" });
  const valencia = await count("buildings", { col: "province", val: "Valencia" });
  console.log(`\nProvincia 'Madrid'    : ${madrid.toLocaleString("es-ES")} (esperado 109.285)`);
  console.log(`Provincia 'Baleares'  : ${baleares.toLocaleString("es-ES")} (esperado 190.984)`);
  console.log(`Provincia 'Valencia'  : ${valencia.toLocaleString("es-ES")}`);

  // Top 10 municipios de Valencia por buildings (paginación + agregación client-side)
  console.log("\n=== Top 10 municipios de provincia Valencia por nº de buildings ===");
  const counts: Record<string, number> = {};
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await supabase
      .from("buildings")
      .select("municipality")
      .eq("province", "Valencia")
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
  console.log(`Total municipios distintos en Valencia: ${top.length}`);
  console.log("Top 10:");
  top.slice(0, 10).forEach(([m, c], i) => {
    console.log(`  ${(i + 1).toString().padStart(2)}. ${m.padEnd(35)} : ${c.toLocaleString("es-ES")}`);
  });

  // Sample 3 buildings de un municipio top no-VALENCIA (capital)
  if (top.length >= 2) {
    const target = top[1][0];
    console.log(`\n=== Sample 3 buildings de ${target} ===`);
    const { data: sample } = await supabase
      .from("buildings")
      .select("parcel_ref, address, municipality, province, year_built, total_units")
      .eq("province", "Valencia")
      .eq("municipality", target)
      .limit(3);
    sample?.forEach((b, i) => console.log(`  [${i + 1}] ${JSON.stringify(b)}`));
  }

  // Tamaño DB: intentar pg_database_size vía RPC (esperado: no disponible)
  console.log("\n=== Tamaño DB (pg_database_size) ===");
  const candidates = ["exec_sql", "query", "execute_sql", "run_sql", "sql_query", "pg_database_size"];
  let dbSizeFound = false;
  for (const name of candidates) {
    const { data, error } = await supabase.rpc(name, { sql: "SELECT pg_database_size(current_database())" });
    if (!error) {
      console.log(`  rpc('${name}') OK -> ${JSON.stringify(data)}`);
      dbSizeFound = true;
      break;
    }
  }
  if (!dbSizeFound) {
    console.log("  No accesible vía cliente JS (sin RPC SQL raw expuesta).");
    console.log("  Estimación basada en sample JSON (sin índices ni overhead Postgres):");
    const { data: sB } = await supabase.from("buildings").select("*").limit(500);
    const { data: sT } = await supabase.from("building_typologies").select("*").limit(500);
    const avgB = sB && sB.length ? Math.round(Buffer.byteLength(JSON.stringify(sB), "utf8") / sB.length) : 0;
    const avgT = sT && sT.length ? Math.round(Buffer.byteLength(JSON.stringify(sT), "utf8") / sT.length) : 0;
    const estB = avgB * totalB;
    const estT = avgT * totalT;
    const estTotal = estB + estT;
    console.log(`  buildings  avg ${avgB} B/fila -> ~${(estB / 1024 / 1024).toFixed(1)} MB`);
    console.log(`  typologies avg ${avgT} B/fila -> ~${(estT / 1024 / 1024).toFixed(1)} MB`);
    console.log(`  TOTAL data only: ~${(estTotal / 1024 / 1024).toFixed(1)} MB (≈${(estTotal / 1024 / 1024 / 1024).toFixed(2)} GB JSON)`);
    console.log(`  Postgres real ≈ 1.3x-2x esto (incluye índices + headers + TOAST).`);
    console.log(`  Para tamaño exacto: Supabase Dashboard -> Settings -> Database -> Database size`);
  }

  console.log("\n=== Veredicto ===");
  console.log(`buildings totales     : ${totalB}`);
  console.log(`typologies totales    : ${totalT}`);
  console.log(`Madrid intacto        : ${madrid === 109285 ? "SI" : `ALERTA (${madrid})`}`);
  console.log(`Baleares intacto      : ${baleares === 190984 ? "SI" : `ALERTA (${baleares})`}`);
  console.log(`Valencia (capital+resto): ${valencia}`);
}

main().catch((err) => { console.error("ERROR:", err); process.exit(1); });
