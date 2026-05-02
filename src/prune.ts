import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { readCatFile } from "./parser/catReader";
import { isCommonElement } from "./parser/recordParser";
import { BuildingGrouper } from "./transformer/grouper";
import { tipologizarEdificio } from "./transformer/typologizer";

dotenv.config();

const MIN_UNITS = 3;

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error("Uso: tsx src/prune.ts <ruta/al/archivo.CAT>");
    process.exit(1);
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    console.error("Faltan SUPABASE_URL / SUPABASE_SERVICE_KEY en .env");
    process.exit(1);
  }
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const fmt = (n: number) => n.toLocaleString("es-ES");

  console.log("🧹 Pruning orphan buildings...\n");
  console.log(`📂 Parseando archivo: ${filePath}`);

  const grouper = new BuildingGrouper();
  const started = Date.now();
  await readCatFile(filePath, (record) => grouper.handle(record));

  const validRefs = new Set<string>();
  for (const b of grouper.all()) {
    const tipo = tipologizarEdificio(b);
    if (tipo.totalUnidades >= MIN_UNITS) validRefs.add(b.refcatParcela);
  }
  console.log(
    `✅ Parcelas válidas en archivo: ${fmt(validRefs.size)} (${Math.round((Date.now() - started) / 1000)}s)`,
  );

  console.log("\n🔍 Descargando todas las parcel_ref actuales en BD...");
  const dbRefs: string[] = [];
  const pageSize = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await client
      .from("buildings")
      .select("parcel_ref")
      .range(from, from + pageSize - 1)
      .order("parcel_ref");
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const row of data) dbRefs.push(row.parcel_ref as string);
    if (data.length < pageSize) break;
    from += pageSize;
    process.stdout.write(`  ... ${fmt(dbRefs.length)} refs leídas\n`);
  }
  console.log(`✅ Total refs en BD: ${fmt(dbRefs.length)}`);

  const orphans = dbRefs.filter((r) => !validRefs.has(r));
  console.log(`\n🗑️  Huérfanos a eliminar: ${fmt(orphans.length)}`);

  if (orphans.length === 0) {
    console.log("Nada que hacer. BD coherente.");
    return;
  }

  const deleteBatch = 500;
  let deletedB = 0;
  let deletedT = 0;
  for (let i = 0; i < orphans.length; i += deleteBatch) {
    const batch = orphans.slice(i, i + deleteBatch);
    const { error: tErr, count: tCount } = await client
      .from("building_typologies")
      .delete({ count: "exact" })
      .in("parcel_ref", batch);
    if (tErr) console.error(`  ⚠️  typ delete error: ${tErr.message}`);
    else deletedT += tCount ?? 0;

    const { error: bErr, count: bCount } = await client
      .from("buildings")
      .delete({ count: "exact" })
      .in("parcel_ref", batch);
    if (bErr) console.error(`  ⚠️  bld delete error: ${bErr.message}`);
    else deletedB += bCount ?? 0;
    process.stdout.write(
      `  ... ${fmt(Math.min(i + deleteBatch, orphans.length))} / ${fmt(orphans.length)} procesados\n`,
    );
  }
  console.log(
    `\n✅ Eliminados: ${fmt(deletedB)} edificios + ${fmt(deletedT)} tipologías huérfanas`,
  );

  const [{ count: finalB }, { count: finalT }] = await Promise.all([
    client
      .from("buildings")
      .select("*", { count: "exact", head: true }),
    client
      .from("building_typologies")
      .select("*", { count: "exact", head: true }),
  ]);
  console.log(`\n📊 Estado final BD:`);
  console.log(`  - buildings: ${fmt(finalB ?? 0)}`);
  console.log(`  - building_typologies: ${fmt(finalT ?? 0)}`);

  console.log(
    "\n📚 Fuente: Dirección General del Catastro (datos elaborados).",
  );
}

main().catch((err) => {
  console.error("Error fatal:", err);
  process.exit(1);
});
