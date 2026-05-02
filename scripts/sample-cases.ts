// sample-cases.ts
// Selecciona 5 ejemplos representativos de Baleares con patrones distintos
// de typologies para validar el comportamiento del fix.

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

type Typ = { use_category: string; unit_count: number; m2_avg: number; floors: string };

async function fetchTypologies(parcelRef: string): Promise<Typ[]> {
  const { data } = await supabase
    .from("building_typologies")
    .select("use_category, unit_count, m2_avg, floors")
    .eq("parcel_ref", parcelRef);
  return (data ?? []) as Typ[];
}

function classify(typs: Typ[]): { totalViv: number; totalInm: number; vivCount: number; nonVivCount: number; pattern: string } {
  let totalViv = 0;
  let totalInm = 0;
  let vivCount = 0;
  let nonVivCount = 0;
  for (const t of typs) {
    totalInm += t.unit_count;
    if (t.use_category.toLowerCase().includes("vivienda")) {
      totalViv += t.unit_count;
      vivCount += 1;
    } else {
      nonVivCount += 1;
    }
  }
  const anexos = totalInm - totalViv;
  let pattern = "";
  if (totalViv === 0 && totalInm > 0) pattern = `0v_${totalInm}otros`;
  else if (totalViv === 1 && anexos === 0) pattern = `1v_0anexos`;
  else if (totalViv === 1 && anexos >= 1 && anexos <= 2) pattern = `1v_${anexos}anexos`;
  else if (totalViv === 2 && anexos === 0) pattern = `2v_0anexos`;
  else if (totalViv === 2 && anexos >= 1 && anexos <= 2) pattern = `2v_${anexos}anexos`;
  return { totalViv, totalInm, vivCount, nonVivCount, pattern };
}

async function main() {
  console.log("=== Sample 5 patrones Baleares ===\n");

  // Descargo más buildings para tener más diversidad
  const { data: buildings } = await supabase
    .from("buildings")
    .select("parcel_ref, address, municipality")
    .eq("province", "Baleares")
    .range(0, 2999);

  if (!buildings) return;

  console.log(`Pool de buildings: ${buildings.length}`);

  const patterns = ["1v_0anexos", "1v_1anexos", "1v_2anexos", "2v_0anexos", "2v_1anexos", "2v_2anexos", "0v_2otros", "0v_3otros"];
  const found: Record<string, { ref: string; addr: string; mun: string; typs: Typ[]; class_: ReturnType<typeof classify> }> = {};

  for (const b of buildings) {
    const ref = (b as { parcel_ref: string }).parcel_ref;
    if (Object.keys(found).length >= patterns.length) break;
    const typs = await fetchTypologies(ref);
    if (typs.length === 0) continue;
    const c = classify(typs);
    if (patterns.includes(c.pattern) && !found[c.pattern]) {
      found[c.pattern] = {
        ref,
        addr: (b as { address: string }).address,
        mun: (b as { municipality: string }).municipality,
        typs,
        class_: c,
      };
    }
  }

  for (const p of patterns) {
    const f = found[p];
    if (!f) {
      console.log(`\n[${p}]  NO encontrado en pool de ${buildings.length} buildings`);
      continue;
    }
    console.log(`\n[${p}]`);
    console.log(`  parcel_ref: ${f.ref}`);
    console.log(`  address   : ${f.addr}`);
    console.log(`  municipio : ${f.mun}`);
    console.log(`  totalViv=${f.class_.totalViv}  totalInm=${f.class_.totalInm}  (${f.typs.length} typologies)`);
    f.typs.forEach((t, i) => {
      console.log(`    [${i + 1}] ${t.use_category.padEnd(28)} unit_count=${t.unit_count} m2=${t.m2_avg} floors=${t.floors}`);
    });
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
