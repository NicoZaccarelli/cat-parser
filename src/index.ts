import { readFileSync } from "node:fs";
import { readCatFile } from "./parser/catReader";
import { isCommonElement } from "./parser/recordParser";
import {
  parseSourceDateFromHeader,
  SupabaseLoader,
  type BuildingRow,
  type TypologyRow,
} from "./loader/supabase";
import type { Building, BuildingTipologias } from "./parser/types";
import { BuildingGrouper } from "./transformer/grouper";
import { printGateResult, runValidationGate } from "./transformer/validationGate";
import {
  compactFloors,
  tipologizarEdificio,
  totalTipologias,
} from "./transformer/typologizer";

const MIN_UNITS = 3;

function fmtNum(n: number): string {
  return n.toLocaleString("es-ES");
}

function fmtSeconds(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}m ${r}s`;
}

interface CliArgs {
  filePath: string;
  searchRefcat: string | null;
  load: boolean;
  dryRun: boolean;
  onlyParcels: string | null;
}

function parseArgs(argv: string[]): CliArgs {
  const rest = argv.slice(2);
  let filePath: string | null = null;
  let searchRefcat: string | null = null;
  let load = false;
  let dryRun = false;
  let onlyParcels: string | null = null;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--search") {
      searchRefcat = (rest[i + 1] ?? "").trim().toUpperCase();
      i++;
    } else if (a === "--load") {
      load = true;
    } else if (a === "--dry-run") {
      dryRun = true;
    } else if (a === "--only-parcels") {
      onlyParcels = (rest[i + 1] ?? "").trim();
      i++;
    } else if (!filePath) {
      filePath = a;
    }
  }
  if (!filePath) {
    console.error(
      "Uso: tsx src/index.ts <ruta/al/archivo.CAT> [--search REFCAT] [--load [--dry-run]] [--only-parcels <fichero>]",
    );
    process.exit(1);
  }
  return { filePath, searchRefcat, load, dryRun, onlyParcels };
}

// Ingesta filtrada: carga/reinserta SOLO estos parcel_ref (14 chars). Parsea
// el .CAT completo pero limita lo que toca la BD → recalcular una muestra sin
// reingestar todo el municipio.
function loadOnlyParcelsSet(path: string): Set<string> {
  const raw = readFileSync(path, "utf8");
  const set = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    const ref = line.trim().toUpperCase();
    if (ref) set.add(ref.slice(0, 14));
  }
  return set;
}

function printTipologiasEdificio(tipo: BuildingTipologias, municipio: string, titulo: string): void {
  console.log(`\n🔬 ${titulo}:\n`);
  console.log(`Edificio: ${tipo.refcatParcela}`);
  console.log(`Dirección: ${tipo.direccion || "(sin dirección)"}`);
  console.log(`Municipio: ${municipio}`);
  console.log(`Año construcción: ${tipo.anoConstruccion ?? "n/d"}`);
  console.log(`Total unidades: ${fmtNum(tipo.totalUnidades)}\n`);
  console.log("Por uso:");

  const usosOrdenados = Object.keys(tipo.porUso).sort(
    (a, b) =>
      tipo.porUso[b].reduce((s, t) => s + t.numUnidades, 0) -
      tipo.porUso[a].reduce((s, t) => s + t.numUnidades, 0),
  );

  for (const uso of usosOrdenados) {
    const tipos = tipo.porUso[uso];
    const total = tipos.reduce((s, t) => s + t.numUnidades, 0);
    console.log(`  📁 ${uso} (${fmtNum(total)} unidades):`);
    for (const t of tipos) {
      const plantasStr =
        t.plantas.length <= 6
          ? t.plantas.join(", ")
          : `${t.plantas[0]}..${t.plantas[t.plantas.length - 1]} (${t.plantas.length} niveles)`;
      console.log(
        `     - Tipología ${t.nombre}: ${fmtNum(t.numUnidades)} unidades · ${t.m2Medio} m² privativa · ${t.m2MedioConstruida} m² construida · (rango ${t.m2Min}-${t.m2Max}) · plantas ${plantasStr}`,
      );
    }
  }
}

function buildRows(
  building: Building,
  tipo: BuildingTipologias,
  sourceDate: string,
): { building: BuildingRow; typologies: TypologyRow[] } {
  const address = [tipo.direccion].filter(Boolean).join(" ").trim();
  const buildingRow: BuildingRow = {
    parcel_ref: building.refcatParcela,
    address: address || "(sin dirección)",
    municipality: building.municipio || "(n/d)",
    province: building.provincia || "(n/d)",
    year_built: tipo.anoConstruccion,
    total_units: tipo.totalUnidades,
    lat: null,
    lng: null,
    source_date: sourceDate,
  };
  const typologies: TypologyRow[] = [];
  for (const [useCategory, tipos] of Object.entries(tipo.porUso)) {
    for (const t of tipos) {
      typologies.push({
        parcel_ref: building.refcatParcela,
        use_category: useCategory,
        typology_name: t.nombre,
        m2_avg: t.m2Medio,
        m2_avg_construida: t.m2MedioConstruida,
        m2_min: t.m2Min,
        m2_max: t.m2Max,
        unit_count: t.numUnidades,
        floors: compactFloors(t.plantas),
      });
    }
  }
  return { building: buildingRow, typologies };
}

async function main() {
  const { filePath, searchRefcat, load, dryRun, onlyParcels } = parseArgs(process.argv);
  const onlyParcelsSet = onlyParcels ? loadOnlyParcelsSet(onlyParcels) : null;

  if (load) {
    console.log(
      `🏛️  Parser CAT - Modo ${dryRun ? "CARGA (DRY-RUN)" : "CARGA a Supabase"}`,
    );
  } else {
    console.log("🏛️  Parser CAT - Catastro Español");
  }
  console.log(`📂 Archivo: ${filePath}`);
  if (load && !dryRun) {
    console.log(`🔌 Supabase: ${process.env.SUPABASE_URL ?? "(no configurado)"}`);
  }
  if (searchRefcat) console.log(`🔍 Búsqueda: ${searchRefcat}`);
  if (onlyParcelsSet) console.log(`🎯 Ingesta filtrada: ${fmtNum(onlyParcelsSet.size)} parcel_ref (${onlyParcels})`);
  console.log("⏳ Procesando...\n");

  const grouper = new BuildingGrouper();
  let fechaGeneracion = "";
  const startedAt = Date.now();

  const { stats, elapsedMs } = await readCatFile(
    filePath,
    (record) => {
      if (record.type === "01" && !fechaGeneracion) {
        fechaGeneracion = record.fechaGeneracion;
      }
      grouper.handle(record);
    },
    (s) => {
      const secs = Math.round((Date.now() - startedAt) / 1000);
      process.stdout.write(
        `  ... ${fmtNum(s.linesRead)} líneas (${secs}s) · parcelas=${fmtNum(s.type11)} · construcciones=${fmtNum(s.type14)}\n`,
      );
    },
  );

  const sourceDate = parseSourceDateFromHeader(fechaGeneracion);

  console.log(`\n✅ Procesamiento completado en ${fmtSeconds(elapsedMs)}\n`);
  console.log("📊 Estadísticas:");
  console.log(`  - Líneas leídas: ${fmtNum(stats.linesRead)}`);
  console.log(`  - Parcelas (11): ${fmtNum(stats.type11)}`);
  console.log(`  - Unidades constructivas (13): ${fmtNum(stats.type13)}`);
  console.log(`  - Construcciones (14): ${fmtNum(stats.type14)}`);
  console.log(`  - Bienes inmuebles (15): ${fmtNum(stats.type15)}`);
  console.log(`  - Reparto superficies (16): ${fmtNum(stats.type16)}`);
  console.log(`  - Edificios (parcelas con unidades): ${fmtNum(grouper.size())}`);
  console.log(`  - Fecha del archivo: ${sourceDate}`);

  // Gate de validación del layout. Corre ANTES de construir filas y de
  // escribir nada: si el fichero no cuadra con el formato verificado, la
  // corrida aborta en vez de dejar la base a medias con datos plausibles y
  // falsos. Ver validationGate.ts para los criterios y por qué la suma de
  // coeficientes es solo un aviso.
  const gate = runValidationGate(grouper);
  printGateResult(gate);
  if (!gate.passed) {
    console.error(
      "\n⛔ Corrida abortada: el layout de este fichero no coincide con el " +
        "verificado. No se ha escrito nada en Supabase.",
    );
    process.exitCode = 2;
    return;
  }

  let comunesTotal = 0;
  let comunesVivienda = 0;
  const plantasDescartadas: Record<string, number> = {};
  for (const b of grouper.all()) {
    for (const u of b.units) {
      if (isCommonElement(u.planta)) {
        comunesTotal++;
        if (u.usoChar === "V") comunesVivienda++;
        plantasDescartadas[u.planta] =
          (plantasDescartadas[u.planta] ?? 0) + 1;
      }
    }
  }
  console.log("\n🅾️  Filtrado elementos comunes (planta no numérica ni 'SM'):");
  console.log(`  - Unidades descartadas: ${fmtNum(comunesTotal)}`);
  if (comunesTotal > 0) {
    const pctViv = ((comunesVivienda / comunesTotal) * 100).toFixed(2);
    console.log(`    (${pctViv}% eran uso Vivienda)`);
    const top = Object.entries(plantasDescartadas)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([k, v]) => `${k}=${fmtNum(v)}`)
      .join(", ");
    console.log(`    top códigos de planta: ${top}`);
  }

  const buildingsRows: BuildingRow[] = [];
  const typologiesRows: TypologyRow[] = [];
  let descartadosPorTamano = 0;
  let tipologiasTotal = 0;

  for (const b of grouper.all()) {
    // Ingesta filtrada: saltar edificios fuera de la muestra.
    if (onlyParcelsSet && !onlyParcelsSet.has(b.refcatParcela)) continue;
    const tipo = tipologizarEdificio(b);
    tipologiasTotal += totalTipologias(tipo);
    if (tipo.totalUnidades < MIN_UNITS) {
      descartadosPorTamano++;
      continue;
    }
    const rows = buildRows(b, tipo, sourceDate);
    buildingsRows.push(rows.building);
    typologiesRows.push(...rows.typologies);
  }

  console.log("\n🔍 Filtros aplicados:");
  console.log(`  - Edificios con <${MIN_UNITS} unidades descartados: ${fmtNum(descartadosPorTamano)}`);
  console.log(`  - Edificios a cargar: ${fmtNum(buildingsRows.length)}`);
  console.log(`  - Tipologías a cargar: ${fmtNum(typologiesRows.length)}`);
  console.log(`\n🧮 Tipologías generadas totales (pre-filtro): ${fmtNum(tipologiasTotal)}`);

  if (load) {
    const loader = new SupabaseLoader({ dryRun });
    if (dryRun) {
      console.log("\n🧪 DRY-RUN: no se escribe nada en Supabase.");
      console.log(
        `  Simularía insertar ${fmtNum(buildingsRows.length)} edificios + ${fmtNum(typologiesRows.length)} tipologías.`,
      );
    } else {
      console.log("\n📤 Cargando a Supabase...");
      const loadStart = Date.now();

      const parcelRefs = buildingsRows.map((r) => r.parcel_ref);
      console.log(`  🗑️  Limpiando tipologías existentes para ${fmtNum(parcelRefs.length)} edificios...`);
      await loader.clearTypologiesFor(parcelRefs);

      const bRes = await loader.loadBuildings(buildingsRows);
      console.log(
        `  ✅ ${fmtNum(bRes.inserted)} edificios cargados${bRes.errors ? ` (${fmtNum(bRes.errors)} errores)` : ""}`,
      );

      const tRes = await loader.loadTypologies(typologiesRows);
      console.log(
        `  ✅ ${fmtNum(tRes.inserted)} tipologías cargadas${tRes.errors ? ` (${fmtNum(tRes.errors)} errores)` : ""}`,
      );

      console.log(`  ⏱️  Tiempo carga: ${fmtSeconds(Date.now() - loadStart)}`);

      console.log("\n🔬 Validación en Supabase:");
      const [bCount, tCount] = await Promise.all([
        loader.countBuildings(),
        loader.countTypologies(),
      ]);
      console.log(`  - Edificios en BD: ${fmtNum(bCount)}`);
      console.log(`  - Tipologías en BD: ${fmtNum(tCount)}`);

      const sample = await loader.sampleBuilding();
      if (sample) {
        console.log("\n  📋 Sample edificio aleatorio:");
        console.log(`    parcel_ref: ${sample.parcel_ref}`);
        console.log(`    address: ${sample.address}`);
        console.log(`    municipality: ${sample.municipality}`);
        console.log(`    year_built: ${sample.year_built ?? "n/d"}`);
        console.log(`    total_units: ${sample.total_units}`);
        const typologies = (sample.typologies as unknown[]) ?? [];
        console.log(`    tipologías (${typologies.length}):`);
        for (const t of typologies as Array<{
          use_category: string;
          typology_name: string;
          m2_avg: number;
          unit_count: number;
          floors: string;
        }>) {
          console.log(
            `      · ${t.use_category} ${t.typology_name}: ${t.unit_count} u · ${t.m2_avg} m² · plantas ${t.floors}`,
          );
        }
      }
    }
  } else if (searchRefcat) {
    const found = grouper.find(searchRefcat);
    if (!found || found.units.length === 0) {
      console.log(`\n❌ Edificio no encontrado en el archivo: ${searchRefcat}`);
    } else {
      const tipo = tipologizarEdificio(found);
      printTipologiasEdificio(
        tipo,
        found.municipio,
        `Tipologías para el edificio buscado (${searchRefcat})`,
      );
    }
  } else {
    const top10 = grouper.topBySize(10);
    console.log("\n🏢 Top 10 edificios con más unidades:\n");
    top10.forEach((b, i) => {
      const dir = [b.direccion, b.numero].filter(Boolean).join(" ").trim();
      console.log(
        `  ${(i + 1).toString().padStart(2)}. ${b.refcatParcela}  ${dir || "(sin dirección)"}  — ${fmtNum(b.units.length)} unidades`,
      );
    });
    if (top10.length > 0) {
      const tipo = tipologizarEdificio(top10[0]);
      printTipologiasEdificio(
        tipo,
        top10[0].municipio,
        "Ejemplo de tipologías para el edificio top 1",
      );
    }
  }

  console.log(
    `\n⏱️  Tiempo total: ${fmtSeconds(Date.now() - startedAt)}`,
  );
  console.log(
    `📚 Fuente: Dirección General del Catastro — datos de ${sourceDate}`,
  );
}

main().catch((err) => {
  console.error("Error fatal:", err);
  process.exit(1);
});
