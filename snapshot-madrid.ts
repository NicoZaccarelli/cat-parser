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
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!,
  { auth: { persistSession: false } },
);

async function paginateMadridBuildings(): Promise<{
  totalBuildings: number;
  byMuni: Record<string, number>;
  parcelRefs: string[];
}> {
  const counts: Record<string, number> = {};
  const parcelRefs: string[] = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await supabase
      .from("buildings")
      .select("municipality, parcel_ref")
      .eq("province", "Madrid")
      .range(from, from + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const r of data) {
      const m = (r as { municipality: string }).municipality;
      counts[m] = (counts[m] ?? 0) + 1;
      parcelRefs.push((r as { parcel_ref: string }).parcel_ref);
    }
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return {
    totalBuildings: parcelRefs.length,
    byMuni: counts,
    parcelRefs,
  };
}

async function countTypologiesFor(parcelRefs: string[]): Promise<number> {
  let total = 0;
  const chunk = 500;
  for (let i = 0; i < parcelRefs.length; i += chunk) {
    const refs = parcelRefs.slice(i, i + chunk);
    const { count, error } = await supabase
      .from("building_typologies")
      .select("*", { count: "exact", head: true })
      .in("parcel_ref", refs);
    if (error) throw error;
    total += count ?? 0;
  }
  return total;
}

async function main() {
  const label = process.argv[2] ?? "snapshot";
  console.log(`=== ${label.toUpperCase()} Madrid ===\n`);

  const t0 = Date.now();
  const { totalBuildings, byMuni, parcelRefs } = await paginateMadridBuildings();
  const totalT = await countTypologiesFor(parcelRefs);

  const ratio = totalBuildings > 0 ? totalT / totalBuildings : 0;

  console.log(`total_buildings province=Madrid : ${totalBuildings.toLocaleString("es-ES")}`);
  console.log(`total_municipios distintos      : ${Object.keys(byMuni).length}`);
  console.log(`total_typologies (Madrid)       : ${totalT.toLocaleString("es-ES")}`);
  console.log(`ratio typologies/buildings      : ${ratio.toFixed(2)}x`);

  const sorted = Object.entries(byMuni).sort((a, b) => b[1] - a[1]);

  console.log(`\nTop 10 municipios (más buildings):`);
  sorted.slice(0, 10).forEach(([m, n], i) => {
    console.log(`  ${(i + 1).toString().padStart(2)}. ${m.padEnd(35)} : ${n.toLocaleString("es-ES")}`);
  });

  console.log(`\nBottom 10 municipios (menos buildings):`);
  sorted.slice(-10).reverse().forEach(([m, n], i) => {
    console.log(`  ${(i + 1).toString().padStart(2)}. ${m.padEnd(35)} : ${n.toLocaleString("es-ES")}`);
  });

  // Detectar municipios con count sospechosamente bajo (<5)
  const lowCount = sorted.filter(([, n]) => n < 5);
  if (lowCount.length > 0) {
    console.log(`\n⚠️  Municipios con <5 buildings (revisar): ${lowCount.length}`);
    lowCount.forEach(([m, n]) => console.log(`     ${m} : ${n}`));
  }

  console.log(`\n(query time: ${Math.round((Date.now() - t0) / 1000)}s)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
