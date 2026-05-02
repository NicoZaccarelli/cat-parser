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

async function countAll(table: string) {
  const { count, error } = await supabase.from(table).select("*", { count: "exact", head: true });
  if (error) throw error;
  return count ?? 0;
}
async function countBy(table: string, col: string, val: string) {
  const { count, error } = await supabase.from(table).select("*", { count: "exact", head: true }).eq(col, val);
  if (error) throw error;
  return count ?? 0;
}

async function main() {
  console.log("=== Snapshot Supabase pre-carga Valencia ===");
  console.log(`Fecha: ${new Date().toISOString()}\n`);

  const totalB = await countAll("buildings");
  const totalT = await countAll("building_typologies");
  console.log(`(a) Total buildings           : ${totalB.toLocaleString("es-ES")} (esperado 300.269)`);
  console.log(`(b) Total building_typologies : ${totalT.toLocaleString("es-ES")} (esperado ~1.36M)`);

  // Detectar formato actual del campo province
  console.log("");
  console.log("=== Sample 5 buildings (formato campo province) ===");
  const { data: sample } = await supabase.from("buildings").select("parcel_ref, province, municipality").limit(5);
  sample?.forEach((r, i) => {
    console.log(`  [${i + 1}] refcat=${r.parcel_ref}  province='${r.province}'  municipality='${r.municipality}'`);
  });

  // (c) Buildings de Valencia — todas las variantes
  console.log("");
  console.log("=== Conteo buildings con province = variantes de Valencia ===");
  const variants = ["46", "Valencia", "VALENCIA", "València", "VALÈNCIA", "Valencia/València", "València/Valencia"];
  let totalValencia = 0;
  for (const v of variants) {
    const c = await countBy("buildings", "province", v);
    console.log(`  province = '${v}': ${c}`);
    if (c > totalValencia) totalValencia = c;
  }

  // (d) Tamaño DB — necesita SQL raw, intentar vía RPC
  console.log("");
  console.log("=== Tamaño DB (pg_database_size requiere SQL raw) ===");
  const candidates = ["exec_sql", "query", "execute_sql", "pg_database_size"];
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
    console.log("  No accesible vía cliente JS (sin función RPC SQL raw).");
    console.log("  Ver Supabase Dashboard -> Settings -> Database -> Database size para tamaño exacto.");
    // Estimación indirecta basada en muestras
    const { data: sB } = await supabase.from("buildings").select("*").limit(500);
    const { data: sT } = await supabase.from("building_typologies").select("*").limit(500);
    const avgB = sB && sB.length ? Math.round(Buffer.byteLength(JSON.stringify(sB), "utf8") / sB.length) : 0;
    const avgT = sT && sT.length ? Math.round(Buffer.byteLength(JSON.stringify(sT), "utf8") / sT.length) : 0;
    const estData = avgB * totalB + avgT * totalT;
    console.log(`  Estimación grosera (data only, JSON, sin índices): ~${(estData / 1024 / 1024).toFixed(0)} MB`);
  }

  console.log("");
  console.log("=== Veredicto ===");
  console.log(`buildings totales        : ${totalB} ${totalB === 300269 ? "(OK)" : "(MISMATCH)"}`);
  console.log(`buildings de Valencia    : ${totalValencia} ${totalValencia === 0 ? "(OK)" : "(NO CERO!)"}`);
}

main().catch((err) => { console.error("ERROR:", err); process.exit(1); });
