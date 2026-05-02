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

async function countAll(table: string) {
  const { count, error } = await supabase.from(table).select("*", { count: "exact", head: true });
  if (error) throw error;
  return count ?? 0;
}
async function countByEq(col: string, val: string) {
  const { count, error } = await supabase.from("buildings").select("*", { count: "exact", head: true }).eq(col, val);
  if (error) throw error;
  return count ?? 0;
}

async function main() {
  console.log("=== Snapshot pre-Sevilla ===");
  console.log(`Fecha: ${new Date().toISOString()}\n`);

  const totalB = await countAll("buildings");
  const totalT = await countAll("building_typologies");
  console.log(`(a) Total buildings  : ${totalB.toLocaleString("es-ES")}  (esperado 1.088.678)`);
  console.log(`(b) Total typologies : ${totalT.toLocaleString("es-ES")}  (esperado 4.410.287)`);

  const expectedB = 1088678;
  const expectedT = 4410287;
  const okB = totalB === expectedB;
  const okT = totalT === expectedT;

  console.log("");
  console.log("(c) Variantes Sevilla en province:");
  const variants = ["Sevilla", "SEVILLA", "41", "Sevilla/Sevilla"];
  let sevTotal = 0;
  for (const v of variants) {
    const c = await countByEq("province", v);
    console.log(`    province = '${v}': ${c}`);
    sevTotal += c;
  }
  console.log(`    Suma variantes Sevilla: ${sevTotal} (esperado 0)`);

  console.log("");
  console.log("=== Provincias actuales (sanity) ===");
  const madrid = await countByEq("province", "Madrid");
  const baleares = await countByEq("province", "Baleares");
  const valencia = await countByEq("province", "Valencia");
  const barcelona = await countByEq("province", "Barcelona");
  console.log(`Madrid    : ${madrid}`);
  console.log(`Baleares  : ${baleares}`);
  console.log(`Valencia  : ${valencia}`);
  console.log(`Barcelona : ${barcelona}`);

  console.log("");
  console.log("=== Veredicto ===");
  console.log(`(a) buildings totales : ${okB ? "OK" : `MISMATCH (esperado ${expectedB}, real ${totalB})`}`);
  console.log(`(b) typologies        : ${okT ? "OK" : `MISMATCH (esperado ${expectedT}, real ${totalT})`}`);
  console.log(`(c) Sevilla presente  : ${sevTotal === 0 ? "NO (OK, listo para cargar)" : `SI (${sevTotal} buildings — PARAR)`}`);

  if (!okB || !okT) { console.log("\n!! PARAR: conteos previos no coinciden."); process.exit(2); }
  if (sevTotal !== 0) { console.log("\n!! PARAR: ya existen datos de Sevilla."); process.exit(3); }
  console.log("\nListo para S2.");
}

main().catch((err) => { console.error("ERROR:", err); process.exit(1); });
