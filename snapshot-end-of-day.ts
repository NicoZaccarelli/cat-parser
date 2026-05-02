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
  console.log("=== CIERRE DE SESIÓN — Estado Supabase ===\n");

  const provinces = ["Madrid", "Baleares", "Valencia", "Barcelona", "Sevilla"];
  let totalB = 0;
  for (const p of provinces) {
    const { count } = await supabase.from("buildings").select("*", { count: "exact", head: true }).eq("province", p);
    const c = count ?? 0;
    console.log(`  ${p.padEnd(12)} : ${c.toLocaleString("es-ES").padStart(10)} buildings`);
    totalB += c;
  }

  const { count: totalAll } = await supabase.from("buildings").select("*", { count: "exact", head: true });
  const { count: totalT } = await supabase.from("building_typologies").select("*", { count: "exact", head: true });

  console.log(`  ${"-".repeat(40)}`);
  console.log(`  Suma 5 provincias: ${totalB.toLocaleString("es-ES").padStart(10)}`);
  console.log(`  Total buildings  : ${(totalAll ?? 0).toLocaleString("es-ES").padStart(10)}`);
  console.log(`  Total typologies : ${(totalT ?? 0).toLocaleString("es-ES").padStart(10)}`);
  console.log(`  Delta            : ${(totalAll ?? 0) - totalB} (debe ser 0)`);
  console.log("\n=== Listo para cerrar sesión ✅ ===");
}

main().catch((e) => { console.error(e); process.exit(1); });
