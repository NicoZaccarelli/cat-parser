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
  console.log("=== Snapshot post-08900U ===");
  console.log(`Fecha: ${new Date().toISOString()}\n`);

  const totalB = await countAll("buildings");
  const totalT = await countAll("building_typologies");
  console.log(`(a) Total buildings  : ${totalB.toLocaleString("es-ES")}  (esperado 751.623)`);
  console.log(`(b) Total typologies : ${totalT.toLocaleString("es-ES")}  (esperado 3.133.970)`);

  console.log("");
  const variants = ["Barcelona", "BARCELONA", "08", "Barcelona/Barcelona", "Barcelona Ciudad"];
  let bestVal = 0;
  let bestKey = "";
  for (const v of variants) {
    const c = await countByEq("province", v);
    console.log(`  province = '${v}': ${c}`);
    if (c > bestVal) { bestVal = c; bestKey = v; }
  }
  console.log(`(c) Mejor match Barcelona: '${bestKey}' = ${bestVal} (esperado 59.365)`);

  const madrid = await countByEq("province", "Madrid");
  const baleares = await countByEq("province", "Baleares");
  const valencia = await countByEq("province", "Valencia");
  console.log("");
  console.log(`Madrid intacto    : ${madrid} (esperado 109.285)`);
  console.log(`Baleares intacto  : ${baleares} (esperado 190.984)`);
  console.log(`Valencia intacto  : ${valencia} (esperado 391.989)`);

  console.log("");
  console.log("=== 3 buildings random de Barcelona ===");
  const { data: sample, error: sErr } = await supabase
    .from("buildings")
    .select("*")
    .eq("province", bestKey)
    .limit(3);
  if (sErr) throw sErr;
  let badRefcat = 0;
  sample?.forEach((r, i) => {
    const len = (r as { parcel_ref: string }).parcel_ref.length;
    if (len !== 14) badRefcat++;
    console.log(`  [${i + 1}] refcat=${(r as { parcel_ref: string }).parcel_ref} (len=${len})`);
    console.log(`      ${JSON.stringify(r)}`);
  });
  console.log(`  Refcats con !=14 chars: ${badRefcat} (esperado 0)`);

  if (sample && sample.length > 0) {
    const refcat = (sample[0] as { parcel_ref: string }).parcel_ref;
    const { data: tipos, error: tErr } = await supabase
      .from("building_typologies")
      .select("*")
      .eq("parcel_ref", refcat);
    if (tErr) throw tErr;
    console.log("");
    console.log(`=== Typologies de ${refcat} (${tipos?.length ?? 0} filas) ===`);
    tipos?.forEach((t, i) => console.log(`  [${i + 1}] ${JSON.stringify(t)}`));
  }

  console.log("");
  console.log("=== Veredicto ===");
  const totalOK = Math.abs(totalB - 751623) <= 751623 * 0.02;
  const bcnOK = Math.abs(bestVal - 59365) <= 59365 * 0.02;
  const madridOK = madrid === 109285;
  const balearesOK = baleares === 190984;
  const valenciaOK = valencia === 391989;
  console.log(`buildings totales: ${totalB} (delta vs pre = ${totalB - 692258})`);
  console.log(`typologies totales: ${totalT}`);
  console.log(`Madrid intacto: ${madridOK ? "SI" : "ALERTA"}`);
  console.log(`Baleares intacto: ${balearesOK ? "SI" : "ALERTA"}`);
  console.log(`Valencia intacto: ${valenciaOK ? "SI" : "ALERTA"}`);
  console.log(`Barcelona capital: ${bestVal} (esperado 59.365)`);
  console.log(`Refcats: ${badRefcat === 0 ? "OK" : "ALERTA"}`);
  if (!totalOK || !bcnOK || !madridOK || !balearesOK || !valenciaOK || badRefcat !== 0) {
    console.log("\n!! PARAR: alguna verificación falló.");
    process.exit(2);
  }
  console.log("\nB3.5 OK — listo para B4.");
}

main().catch((err) => { console.error("ERROR:", err); process.exit(1); });
