import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";

// Manual .env loader — no external dep
const envPath = path.join(process.cwd(), ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf-8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY;
if (!url || !key) {
  console.error("FALTA SUPABASE_URL o SUPABASE_SERVICE_KEY en .env");
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { persistSession: false } });

async function countBy(filter?: { col: string; op: string; val: string }) {
  let q = supabase.from("buildings").select("*", { count: "exact", head: true });
  if (filter) {
    if (filter.op === "eq") q = q.eq(filter.col, filter.val);
    else if (filter.op === "ilike") q = q.ilike(filter.col, filter.val);
  }
  const { count, error } = await q;
  if (error) throw error;
  return count ?? 0;
}

async function main() {
  console.log("=== Snapshot Supabase pre-carga Palma ===");
  console.log(`Fecha: ${new Date().toISOString()}`);
  console.log("");

  // (a) total buildings
  const totalBuildings = await countBy();
  console.log(`(a) Total buildings           : ${totalBuildings.toLocaleString("es-ES")}`);

  // (b) total typologies
  const { count: tCount, error: tErr } = await supabase
    .from("building_typologies")
    .select("*", { count: "exact", head: true });
  if (tErr) throw tErr;
  console.log(`(b) Total building_typologies : ${(tCount ?? 0).toLocaleString("es-ES")}`);

  // (c) Sample para detectar el formato real del campo province
  console.log("");
  console.log("=== Detectar formato de campo province ===");
  const { data: sample, error: sErr } = await supabase
    .from("buildings")
    .select("parcel_ref, province, municipality")
    .limit(5);
  if (sErr) throw sErr;
  console.log("Sample 5 buildings (province + municipality):");
  sample?.forEach((r, i) => {
    console.log(`  [${i + 1}] refcat=${r.parcel_ref}  province='${r.province}'  municipality='${r.municipality}'`);
  });

  // (d) Conteo por todas las variantes plausibles de Baleares
  console.log("");
  console.log("=== Conteo buildings con province = variantes de Baleares ===");
  const variants = ["07", "7", "Baleares", "BALEARES", "Illes Balears", "ILLES BALEARS", "IllesBalears"];
  let totalBaleares = 0;
  for (const v of variants) {
    const c = await countBy({ col: "province", op: "eq", val: v });
    console.log(`  province = '${v}': ${c}`);
    totalBaleares += c;
  }
  // Búsqueda extra defensiva con ILIKE
  const ilikeBaleares = await countBy({ col: "province", op: "ilike", val: "%balear%" });
  const ilikeIlles = await countBy({ col: "province", op: "ilike", val: "%illes%" });
  console.log(`  province ILIKE '%balear%' : ${ilikeBaleares}`);
  console.log(`  province ILIKE '%illes%'  : ${ilikeIlles}`);

  console.log("");
  console.log("=== Veredicto ===");
  console.log(`Total buildings        : ${totalBuildings} (esperado ~109.285 Madrid)`);
  console.log(`Total typologies       : ${tCount} (esperado ~531.896)`);
  console.log(`Buildings de Baleares  : eq=${totalBaleares} ilike-balear=${ilikeBaleares} ilike-illes=${ilikeIlles}`);
}

main().catch((err) => {
  console.error("ERROR:", err);
  process.exit(1);
});
