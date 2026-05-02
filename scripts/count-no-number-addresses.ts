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

const SAMPLE = 5000;

async function analyze(province: string) {
  console.log(`\n=== ${province} (sample ${SAMPLE}) ===`);
  const { data } = await supabase
    .from("buildings")
    .select("address")
    .eq("province", province)
    .range(0, SAMPLE - 1);
  if (!data) return;

  let total = data.length;
  let withNumber = 0;
  let noNumber = 0;
  let withSN = 0; // "Sin Número" placeholder
  let exampleNoNumber: string[] = [];

  for (const b of data) {
    const addr = (b as { address: string }).address ?? "";
    const hasDigit = /\d/.test(addr);
    const hasSN = /\bSN\b/.test(addr); // "Sin Número"
    if (hasDigit) {
      withNumber++;
    } else {
      noNumber++;
      if (hasSN) withSN++;
      if (exampleNoNumber.length < 5) exampleNoNumber.push(addr);
    }
  }
  console.log(`  Total muestra        : ${total}`);
  console.log(`  Con número          : ${withNumber} (${((withNumber/total)*100).toFixed(1)}%)`);
  console.log(`  Sin número (BUG)    : ${noNumber} (${((noNumber/total)*100).toFixed(1)}%)`);
  console.log(`  Con "SN" placeholder: ${withSN}`);
  console.log(`  Ejemplos sin número:`);
  exampleNoNumber.forEach((e, i) => console.log(`    [${i+1}] ${e}`));
}

async function main() {
  console.log("=== Análisis direcciones SIN número de portal ===");
  for (const p of ["Baleares", "Madrid", "Valencia", "Barcelona", "Sevilla"]) {
    await analyze(p);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
