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
  const parcelRef = "2194401ED3729S";

  console.log("=== BUILDING ===");
  const { data: building } = await supabase.from("buildings")
    .select("*").eq("parcel_ref", parcelRef).maybeSingle();
  console.log(JSON.stringify(building, null, 2));

  console.log("\n=== TYPOLOGIES (todas las columnas) ===");
  const { data: typologies } = await supabase.from("building_typologies")
    .select("*").eq("parcel_ref", parcelRef);
  console.log(`Total filas: ${typologies?.length}`);
  console.log(JSON.stringify(typologies, null, 2));

  // Comparar con casos similares: ¿qué edificios verdaderos tienen?
  console.log("\n=== CASO MULTIVIVIENDA REAL para comparar ===");
  // Pillar un building con muchas unidades para ver diferencia de schema
  const { data: multi } = await supabase.from("buildings")
    .select("parcel_ref, total_units, address")
    .eq("province", "Baleares")
    .eq("municipality", "MANACOR")
    .gte("total_units", 10)
    .limit(1);
  if (multi && multi.length > 0) {
    console.log("Ejemplo:", multi[0]);
    const { data: multiTyp } = await supabase.from("building_typologies")
      .select("*").eq("parcel_ref", multi[0].parcel_ref);
    console.log(`Sus typologies (${multiTyp?.length}):`);
    console.log(JSON.stringify(multiTyp?.slice(0,3), null, 2));
  }
}
main().catch(e => { console.error(e); process.exit(1); });
