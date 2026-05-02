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
  console.log("=== Buildings con parcel_ref = 2194103ED3729S ===");
  const { data: bldg } = await supabase
    .from("buildings")
    .select("*")
    .eq("parcel_ref", "2194103ED3729S")
    .maybeSingle();
  console.log(JSON.stringify(bldg, null, 2));

  console.log("\n=== Typologies con parcel_ref = 2194103ED3729S ===");
  const { data: typs } = await supabase
    .from("building_typologies")
    .select("*")
    .eq("parcel_ref", "2194103ED3729S");
  console.log(`Count: ${typs?.length ?? 0}`);
  console.log(JSON.stringify(typs, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
