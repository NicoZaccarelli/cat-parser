/**
 * check-db-size.ts
 *
 * Solo lectura. Reporta lo que se pueda obtener vía SUPABASE_SERVICE_KEY:
 *  - Conteos exactos por tabla
 *  - Bytes aproximados por fila (estimados desde JSON serialization, sin índices)
 *  - Intento de RPCs candidatas para SQL raw (reporta si no existen)
 *
 * NO escribe nada. NO crea funciones.
 */
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

const url = process.env.SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_KEY!;
const supabase = createClient(url, key, { auth: { persistSession: false } });

async function exactCount(table: string): Promise<number> {
  const { count, error } = await supabase
    .from(table)
    .select("*", { count: "exact", head: true });
  if (error) throw error;
  return count ?? 0;
}

async function avgRowBytes(table: string, sampleSize = 1000): Promise<{ rows: number; avgBytes: number; sampleBytes: number }> {
  const { data, error } = await supabase.from(table).select("*").limit(sampleSize);
  if (error) throw error;
  if (!data || data.length === 0) return { rows: 0, avgBytes: 0, sampleBytes: 0 };
  const json = JSON.stringify(data);
  // Approximation: each row's serialized JSON length is roughly its on-disk size.
  // Real Postgres storage adds tuple headers, alignment, TOAST overhead, indexes.
  // This estimate is LOWER bound for table data, EXCLUDES indexes.
  const sampleBytes = Buffer.byteLength(json, "utf8");
  const avgBytes = Math.round(sampleBytes / data.length);
  return { rows: data.length, avgBytes, sampleBytes };
}

async function tryRpc(name: string, args: Record<string, unknown> = {}) {
  const { data, error } = await supabase.rpc(name, args);
  return { ok: !error, data, error: error?.message };
}

async function main() {
  console.log("=== check-db-size (read-only) ===");
  console.log(`Fecha: ${new Date().toISOString()}\n`);

  // 1. Exact row counts
  console.log("--- 1. Conteos exactos ---");
  const cBuildings = await exactCount("buildings");
  const cTypologies = await exactCount("building_typologies");
  console.log(`buildings           : ${cBuildings.toLocaleString("es-ES")}`);
  console.log(`building_typologies : ${cTypologies.toLocaleString("es-ES")}`);
  console.log(`TOTAL filas         : ${(cBuildings + cTypologies).toLocaleString("es-ES")}`);

  // 2. Estimación bytes/fila desde JSON sample (NO incluye índices)
  console.log("\n--- 2. Estimación bytes por fila (JSON, sin índices) ---");
  const bSample = await avgRowBytes("buildings", 1000);
  const tSample = await avgRowBytes("building_typologies", 1000);
  console.log(`buildings sample(${bSample.rows})           : ${bSample.avgBytes.toLocaleString("es-ES")} bytes/fila`);
  console.log(`building_typologies sample(${tSample.rows}) : ${tSample.avgBytes.toLocaleString("es-ES")} bytes/fila`);

  // 3. Estimación tamaño total tabla (datos JSON serializados, sin índices ni overhead)
  console.log("\n--- 3. Estimación tamaño total (data only, sin índices) ---");
  const estB = bSample.avgBytes * cBuildings;
  const estT = tSample.avgBytes * cTypologies;
  const estTotal = estB + estT;
  console.log(`buildings           : ~${(estB / 1024 / 1024).toFixed(1)} MB (≈${estB.toLocaleString("es-ES")} bytes)`);
  console.log(`building_typologies : ~${(estT / 1024 / 1024).toFixed(1)} MB (≈${estT.toLocaleString("es-ES")} bytes)`);
  console.log(`TOTAL estimado data : ~${(estTotal / 1024 / 1024).toFixed(1)} MB (≈${(estTotal / 1024 / 1024 / 1024).toFixed(2)} GB)`);
  console.log("⚠️  Esta estimación NO incluye:");
  console.log("    - Índices (PRIMARY KEY, FK, etc.)");
  console.log("    - Tuple headers de Postgres (~24 bytes/fila)");
  console.log("    - TOAST overhead (campos grandes desbordados)");
  console.log("    - Alignment padding");
  console.log("    - Realidad: Postgres suele ocupar 1.3x–2x más que el JSON estimado");

  // 4. Intentar RPCs candidatas para SQL raw (todas fallarán salvo que existan en este proyecto)
  console.log("\n--- 4. RPCs candidatas para pg_size_pretty (probando si existen) ---");
  const candidates = ["exec_sql", "query", "execute_sql", "run_sql", "sql_query", "pg_size_pretty"];
  for (const name of candidates) {
    const r = await tryRpc(name, { sql: "SELECT 1" });
    console.log(`  rpc('${name}') -> ${r.ok ? "OK (existe)" : "no disponible: " + (r.error || "").slice(0, 80)}`);
  }

  // 5. Sample row para mostrar tamaño de un building real
  console.log("\n--- 5. Sample 1 fila buildings ---");
  const { data: oneB } = await supabase.from("buildings").select("*").limit(1);
  if (oneB && oneB[0]) {
    const sz = Buffer.byteLength(JSON.stringify(oneB[0]), "utf8");
    console.log(`  ${sz} bytes JSON: ${JSON.stringify(oneB[0])}`);
  }
  console.log("\n--- Sample 1 fila typologies ---");
  const { data: oneT } = await supabase.from("building_typologies").select("*").limit(1);
  if (oneT && oneT[0]) {
    const sz = Buffer.byteLength(JSON.stringify(oneT[0]), "utf8");
    console.log(`  ${sz} bytes JSON: ${JSON.stringify(oneT[0])}`);
  }

  console.log("\n=== Limitaciones ===");
  console.log("Para tamaño REAL en disco (incluyendo índices) necesitas pg_size_pretty,");
  console.log("que requiere SQL raw. Opciones:");
  console.log("  A) Pegar las queries SQL en el SQL Editor del dashboard de Supabase");
  console.log("  B) Darme el connection string Postgres directo (postgres://...) con password");
  console.log("  C) Aprobar crear una función RPC en la BD (modificación leve)");
}

main().catch((err) => { console.error("ERROR:", err); process.exit(1); });
