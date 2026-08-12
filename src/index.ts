import { readFileSync } from "node:fs";
import { readCatFile } from "./parser/catReader";
import { assertEntornoPermitido, hostDe } from "./loader/entorno";
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
  /**
   * Censo global de la base al terminar. Es CARO (COUNT sobre tablas de
   * millones de filas), así que se pide explícitamente y se lanza una vez
   * por provincia, no una por municipio. Ver el comentario de `census()` en
   * loader/supabase.ts para el porqué.
   */
  census: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const rest = argv.slice(2);
  let filePath: string | null = null;
  let searchRefcat: string | null = null;
  let load = false;
  let dryRun = false;
  let onlyParcels: string | null = null;
  let census = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--search") {
      searchRefcat = (rest[i + 1] ?? "").trim().toUpperCase();
      i++;
    } else if (a === "--load") {
      load = true;
    } else if (a === "--dry-run") {
      dryRun = true;
    } else if (a === "--census") {
      census = true;
    } else if (a === "--only-parcels") {
      onlyParcels = (rest[i + 1] ?? "").trim();
      i++;
    } else if (!filePath) {
      filePath = a;
    }
  }
  if (!filePath) {
    console.error(
      "Uso: tsx src/index.ts <ruta/al/archivo.CAT> [--search REFCAT] [--load [--dry-run]] [--only-parcels <fichero>] [--census]",
    );
    process.exit(1);
  }
  return { filePath, searchRefcat, load, dryRun, onlyParcels, census };
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
  const { filePath, searchRefcat, load, dryRun, onlyParcels, census } = parseArgs(process.argv);
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
    console.log(`🔌 Supabase: ${hostDe(process.env.SUPABASE_URL ?? "")}`);
  }
  if (searchRefcat) console.log(`🔍 Búsqueda: ${searchRefcat}`);
  if (onlyParcelsSet) console.log(`🎯 Ingesta filtrada: ${fmtNum(onlyParcelsSet.size)} parcel_ref (${onlyParcels})`);

  // ⚠️ La guarda de entorno va AQUÍ, antes de `readCatFile`, y no solo en el
  // constructor de SupabaseLoader: ese se instancia después de parsear, así
  // que comprobar únicamente allí abortaría tras haber leído el fichero
  // entero — minutos en una provincia grande, y casi una hora en Madrid
  // capital. Fallar antes de empezar es la mitad del valor de una guarda.
  //
  // El loader la repite igualmente en toda escritura: main() no es el único
  // sitio desde el que se puede instanciar uno.
  if (load && !dryRun) {
    await assertEntornoPermitido(
      process.env.SUPABASE_URL ?? "",
      process.env.SUPABASE_SERVICE_KEY ?? "",
      "carga",
    );
  }

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

  // Parcelas leídas EN ESTA CORRIDA que caen por debajo del umbral. Sus filas
  // antiguas hay que borrarlas, no solo dejar de escribirlas: al agrupar por
  // bien inmueble muchos edificios falsos se quedan en 1-2 viviendas, y sin el
  // borrado la app seguiría sirviendo el desglose viejo y erróneo (CL Puerto
  // 47, La Acebeda: 4 viviendas de 66 m² que en realidad son 2 de 134 y 128).
  //
  // ⚠️ El conjunto se deriva SIEMPRE de lo leído en el fichero, nunca de una
  // consulta a la base, para que no pueda alcanzar a una parcela que esta
  // corrida no ha procesado. Con --only-parcels queda acotado al filtro.
  const refsBajoUmbral: string[] = [];

  for (const b of grouper.all()) {
    // Ingesta filtrada: saltar edificios fuera de la muestra.
    if (onlyParcelsSet && !onlyParcelsSet.has(b.refcatParcela)) continue;
    const tipo = tipologizarEdificio(b);
    tipologiasTotal += totalTipologias(tipo);
    if (tipo.totalUnidades < MIN_UNITS) {
      descartadosPorTamano++;
      refsBajoUmbral.push(b.refcatParcela);
      continue;
    }
    const rows = buildRows(b, tipo, sourceDate);
    buildingsRows.push(rows.building);
    typologiesRows.push(...rows.typologies);
  }

  console.log("\n🔍 Filtros aplicados:");
  console.log(`  - Edificios con <${MIN_UNITS} unidades descartados: ${fmtNum(descartadosPorTamano)}`);
  console.log(`  - Parcelas a BORRAR por caer bajo el umbral: ${fmtNum(refsBajoUmbral.length)}`);
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

      // Primero el borrado de las que dejan de ser edificio con desglose: si
      // la corrida se corta después, esas parcelas quedan sin caché (la app
      // cae al flujo DNPRC), que es el estado correcto para ellas.
      if (refsBajoUmbral.length > 0) {
        console.log(
          `  🗑️  Borrando ${fmtNum(refsBajoUmbral.length)} parcelas que caen bajo el umbral de ${MIN_UNITS} unidades...`,
        );
        const dRes = await loader.deleteBuildings(refsBajoUmbral);
        console.log(`  ✅ ${fmtNum(dRes.deleted)} parcelas borradas`);
      }

      const bRes = await loader.loadBuildings(buildingsRows);
      console.log(
        `  ✅ ${fmtNum(bRes.inserted)} edificios cargados${bRes.errors ? ` (${fmtNum(bRes.errors)} errores)` : ""}`,
      );

      // Borrado + inserción lote a lote: la ventana de inconsistencia es de un
      // lote, no del fichero entero. Ver replaceTypologies.
      const tRes = await loader.replaceTypologies(typologiesRows);
      console.log(
        `  ✅ ${fmtNum(tRes.inserted)} tipologías cargadas${tRes.errors ? ` (${fmtNum(tRes.errors)} errores)` : ""}`,
      );

      console.log(`  ⏱️  Tiempo carga: ${fmtSeconds(Date.now() - loadStart)}`);

      // ─── Verificación de ida y vuelta ────────────────────────────────
      //
      // Aquí había un bloque que, tras CADA municipio, lanzaba dos COUNT
      // globales y una lectura con OFFSET aleatorio sobre 7,1 M filas.
      // Medido el 11-08-2026: ~15 s por municipio, de los cuales el COUNT de
      // `building_typologies` y la lectura aleatoria expiraban casi siempre.
      // Con 8.393 municipios eran ~35 h de las 94 h de la corrida nacional
      // — el 37 % — gastadas en diagnósticos que no diagnosticaban.
      //
      // Lo que queda comprueba lo único que importa a nivel de fichero: que
      // un edificio que ACABAMOS de escribir se puede volver a leer, con sus
      // tipologías. Va por clave primaria, así que es instantáneo. El censo
      // global vive ahora tras `--census`, para lanzarlo una vez por
      // provincia y no una vez por municipio.
      const primera = buildingsRows[0]?.parcel_ref;
      if (primera) {
        const leido = await loader.readBackBuilding(primera);
        if (!leido) {
          console.log(
            `\n  ⚠️  Verificación: el edificio ${primera} NO se relee tras escribirlo.`,
          );
        } else {
          const tips = ((leido.typologies as unknown[]) ?? []) as Array<{
            use_category: string;
            typology_name: string;
            m2_avg: number;
            unit_count: number;
            floors: string;
          }>;
          console.log(
            `\n  🔬 Verificación de ida y vuelta: ${leido.address} · ` +
              `${leido.total_units} unidades · ${tips.length} tipologías releídas`,
          );
          for (const t of tips.slice(0, 4)) {
            console.log(
              `      · ${t.use_category} ${t.typology_name}: ${t.unit_count} u · ${t.m2_avg} m² · plantas ${t.floors}`,
            );
          }
          if (tips.length === 0) {
            console.log(
              "      ⚠️  Cero tipologías releídas: el edificio quedó sin ellas.",
            );
          }
        }
      }
    }

    if (census && !dryRun) {
      console.log("\n🌍 Censo global (recuento estimado del planificador):");
      const loaderCenso = new SupabaseLoader({ dryRun });
      const [b, t] = await Promise.all([
        loaderCenso.census("buildings"),
        loaderCenso.census("building_typologies"),
      ]);
      console.log(`  - Edificios en BD : ~${fmtNum(b.n)}`);
      console.log(`  - Tipologías en BD: ~${fmtNum(t.n)}`);
      console.log(
        "  (estimado: no escanea las tablas. Un COUNT exacto sobre " +
          "building_typologies expira.)",
      );
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
  const msg = err instanceof Error ? err.message : String(err);
  // La guarda de entorno ya trae su mensaje formateado y explica qué hacer.
  // El volcado de pila solo añadiría ruido: abortar ahí no es un bug, es la
  // guarda funcionando.
  if (msg.includes("Abortado antes de escribir nada")) {
    console.error(msg);
  } else {
    console.error("Error fatal:", err);
  }
  // `process.exitCode` y no `process.exit()`: cortar de golpe con los sockets
  // de undici todavía cerrándose dispara una aserción de libuv en Windows
  // ("!(handle->flags & UV_HANDLE_CLOSING)") que sustituye el código de salida
  // por 127. El script de carga lee ese código para decidir el estado del
  // municipio, así que tiene que ser el que queremos.
  process.exitCode = 1;
});
