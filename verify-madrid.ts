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

async function main() {
  // Conteo por provincia
  const provinces = ["Madrid", "Baleares", "Valencia", "Barcelona"];
  let total = 0;
  for (const p of provinces) {
    const { count } = await supabase.from("buildings").select("*", { count: "exact", head: true }).eq("province", p);
    console.log(`${p.padEnd(12)} : ${(count ?? 0).toLocaleString("es-ES")}`);
    total += count ?? 0;
  }

  // Total y typologies
  const { count: totalAll } = await supabase.from("buildings").select("*", { count: "exact", head: true });
  const { count: totalT } = await supabase.from("building_typologies").select("*", { count: "exact", head: true });

  console.log(`\nSuma 4 provincias  : ${total.toLocaleString("es-ES")}`);
  console.log(`Total tabla buildings: ${(totalAll ?? 0).toLocaleString("es-ES")}`);
  console.log(`Total typologies     : ${(totalT ?? 0).toLocaleString("es-ES")}`);
  console.log(`\nDelta provincias vs total tabla: ${(totalAll ?? 0) - total} (debería ser 0)`);
  console.log(`\nMadrid intacto desde enero: ${109285 === (await supabase.from("buildings").select("*", { count: "exact", head: true }).eq("province", "Madrid")).count ? "SI" : "ALERTA"}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
