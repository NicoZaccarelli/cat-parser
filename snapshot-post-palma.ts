import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";

// Manual .env loader
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
  console.error("FALTA SUPABASE_URL o SUPABASE_SERVICE_KEY");
  process.exit(1);
}
const supabase = createClient(url, key, { auth: { persistSession: false } });

async function countAll() {
  const { count } = await supabase.from("buildings").select("*", { count: "exact", head: true });
  return count ?? 0;
}
async function countTypologies() {
  const { count } = await supabase.from("building_typologies").select("*", { count: "exact", head: true });
  return count ?? 0;
}
async function countByProvince(val: string) {
  const { count } = await supabase
    .from("buildings")
    .select("*", { count: "exact", head: true })
    .eq("province", val);
  return count ?? 0;
}

async function main() {
  console.log("=== Snapshot Supabase post-carga Palma ===");
  console.log(`Fecha: ${new Date().toISOString()}`);
  console.log("");

  const total = await countAll();
  const totalT = await countTypologies();
  console.log(`(a) Total buildings           : ${total.toLocaleString("es-ES")} (esperado ~137.748)`);
  console.log(`(b) Total building_typologies : ${totalT.toLocaleString("es-ES")} (esperado ~675.000)`);

  // (c) buildings de Baleares — probamos las variantes plausibles
  const variants = ["Baleares", "BALEARES", "Illes Balears", "ILLES BALEARS", "07"];
  console.log("");
  console.log("(c) Conteo buildings por valor de province (Baleares):");
  let baleares = 0;
  let baleresValue = "";
  for (const v of variants) {
    const c = await countByProvince(v);
    console.log(`    province = '${v}': ${c}`);
    if (c > baleares) { baleares = c; baleresValue = v; }
  }
  console.log(`    -> mejor match: '${baleresValue}' = ${baleares} (esperado 28.463)`);

  // Madrid sigue intacto?
  const madrid = await countByProvince("Madrid");
  console.log("");
  console.log(`Madrid sigue intacto: ${madrid} (esperado ~109.285)`);

  // Sanity: ningún refcat de 20 chars (deben ser 14)
  console.log("");
  console.log("=== Sanity: refcats con != 14 chars ===");
  const { data: lengths, error: lenErr } = await supabase
    .from("buildings")
    .select("parcel_ref")
    .eq("province", baleresValue);
  if (lenErr) throw lenErr;
  const badLengths = (lengths ?? []).filter((r: { parcel_ref: string }) => r.parcel_ref.length !== 14);
  console.log(`Buildings de Baleares con refcat != 14 chars: ${badLengths.length} (esperado 0)`);
  if (badLengths.length > 0) {
    console.log("Ejemplos:");
    badLengths.slice(0, 5).forEach((r: { parcel_ref: string }) =>
      console.log(`  ${r.parcel_ref} (len=${r.parcel_ref.length})`),
    );
  }

  // (d) 3 buildings random de Baleares
  console.log("");
  console.log("=== 3 buildings random de Baleares (SELECT *) ===");
  const { data: sample, error: sErr } = await supabase
    .from("buildings")
    .select("*")
    .eq("province", baleresValue)
    .limit(3);
  if (sErr) throw sErr;
  sample?.forEach((r, i) => {
    console.log(`--- Building [${i + 1}] ---`);
    console.log(JSON.stringify(r, null, 2));
  });

  // (e) typologies del primer sample
  if (sample && sample.length > 0) {
    const refcat = (sample[0] as { parcel_ref: string }).parcel_ref;
    console.log("");
    console.log(`=== Typologies del primer sample (parcel_ref=${refcat}) ===`);
    const { data: tipos, error: tErr } = await supabase
      .from("building_typologies")
      .select("*")
      .eq("parcel_ref", refcat);
    if (tErr) throw tErr;
    console.log(`Total typologies: ${(tipos ?? []).length}`);
    tipos?.forEach((t, i) => {
      console.log(`  [${i + 1}] ${JSON.stringify(t)}`);
    });
  }

  console.log("");
  console.log("=== Veredicto ===");
  console.log(`buildings totales: ${total} (delta = ${total - 109285})`);
  console.log(`typologies totales: ${totalT} (delta = ${totalT - 531896})`);
  console.log(`buildings Baleares: ${baleares}`);
  console.log(`Madrid intacto: ${madrid === 109285 ? "SI" : "ALERTA: " + madrid}`);
  console.log(`refcats != 14 chars en Baleares: ${badLengths.length}`);
}

main().catch((err) => {
  console.error("ERROR:", err);
  process.exit(1);
});
