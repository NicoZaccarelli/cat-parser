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
  console.log("=== Buildings con municipality LLUCMAJOR ===\n");
  const { count } = await supabase.from("buildings")
    .select("*", { count: "exact", head: true })
    .ilike("municipality", "%llucmajor%");
  console.log(`Total buildings ilike '%llucmajor%': ${count}`);

  const { data } = await supabase.from("buildings")
    .select("parcel_ref, address, municipality, province")
    .ilike("municipality", "%llucmajor%")
    .limit(5);
  console.log("\nMuestra:");
  for (const b of data ?? []) {
    console.log(`  ${b.parcel_ref} | mun='${b.municipality}' | prov='${b.province}' | ${b.address}`);
  }

  // Variantes de casing
  console.log("\n=== Distinct values de 'municipality' que contienen 'llucmajor' (case-insensitive) ===");
  const { data: distinct } = await supabase.from("buildings")
    .select("municipality")
    .ilike("municipality", "%llucmajor%")
    .limit(100);
  const unique = [...new Set((distinct ?? []).map(r => r.municipality))];
  console.log(unique);
}
main().catch(e => { console.error(e); process.exit(1); });
