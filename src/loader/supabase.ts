import { createClient, SupabaseClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

export interface BuildingRow {
  parcel_ref: string;
  address: string;
  municipality: string;
  province: string;
  year_built: number | null;
  total_units: number;
  lat: number | null;
  lng: number | null;
  source_date: string;
}

export interface TypologyRow {
  parcel_ref: string;
  use_category: string;
  typology_name: string;
  m2_avg: number;
  m2_avg_construida: number;
  m2_min: number;
  m2_max: number;
  unit_count: number;
  floors: string;
}

interface LoaderOpts {
  dryRun: boolean;
  batchSize?: number;
  progressEvery?: number;
}

export class SupabaseLoader {
  private client: SupabaseClient | null = null;
  private dryRun: boolean;
  private batchSize: number;
  private progressEvery: number;

  constructor(opts: LoaderOpts) {
    this.dryRun = opts.dryRun;
    // Batch size reducido tras observar statement timeouts en Málaga: con 500
    // rows/insert algunos batches >8s bajo carga → 50 rows/insert << 8s siempre.
    this.batchSize = opts.batchSize ?? 50;
    this.progressEvery = opts.progressEvery ?? 5_000;
    if (!this.dryRun) {
      const url = process.env.SUPABASE_URL;
      const key = process.env.SUPABASE_SERVICE_KEY;
      if (!url || !key) {
        throw new Error(
          "Faltan SUPABASE_URL / SUPABASE_SERVICE_KEY en .env",
        );
      }
      this.client = createClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
    }
  }

  isDryRun(): boolean {
    return this.dryRun;
  }

  private requireClient(): SupabaseClient {
    if (!this.client) {
      throw new Error("Supabase client no inicializado (modo dry-run)");
    }
    return this.client;
  }

  async loadBuildings(rows: BuildingRow[]): Promise<{
    inserted: number;
    errors: number;
  }> {
    if (this.dryRun) {
      return { inserted: rows.length, errors: 0 };
    }
    const client = this.requireClient();
    let inserted = 0;
    let errors = 0;
    for (let i = 0; i < rows.length; i += this.batchSize) {
      const batch = rows.slice(i, i + this.batchSize);
      const { error } = await client
        .from("buildings")
        .upsert(batch, { onConflict: "parcel_ref" });
      if (error) {
        errors += batch.length;
        console.error(
          `  ⚠️  Error batch edificios [${i}-${i + batch.length}]: ${error.message}`,
        );
      } else {
        inserted += batch.length;
      }
      if (inserted % this.progressEvery < this.batchSize) {
        process.stdout.write(
          `  ... ${inserted.toLocaleString("es-ES")} edificios cargados\n`,
        );
      }
    }
    return { inserted, errors };
  }


  /**
   * Borra e inserta las tipologías LOTE A LOTE, agrupando por parcela.
   *
   * Antes se borraban de una vez las tipologías de todo el fichero y luego se
   * insertaban en lotes de 50: en Madrid capital eso dejaba la ciudad entera
   * sin tipologías durante los ~4 minutos que dura la carga, y un aborto a
   * mitad la dejaba así hasta relanzar.
   *
   * Ahora cada lote borra sus propias parcelas y las reinserta acto seguido,
   * de modo que la ventana de inconsistencia es de un lote y no del fichero.
   *
   * ⚠️ No es transaccional —supabase-js no ofrece transacción entre delete e
   * insert— así que la ventana se reduce, no desaparece. Si aborta a mitad
   * quedan parcelas nuevas y parcelas viejas mezcladas, que es preferible a
   * media ciudad vacía, y relanzar el mismo fichero converge igual.
   *
   * Las parcelas nunca se parten entre lotes: se agrupa por `parcel_ref` y un
   * lote se cierra al superar `batchSize` filas, de modo que el borrado de una
   * parcela y la inserción de todas sus tipologías van siempre juntos.
   */
  async replaceTypologies(rows: TypologyRow[]): Promise<{
    inserted: number;
    errors: number;
  }> {
    if (this.dryRun) {
      return { inserted: rows.length, errors: 0 };
    }
    const client = this.requireClient();

    // Agrupa por parcela conservando el orden de llegada.
    const porParcela = new Map<string, TypologyRow[]>();
    for (const r of rows) {
      const arr = porParcela.get(r.parcel_ref);
      if (arr) arr.push(r);
      else porParcela.set(r.parcel_ref, [r]);
    }

    // Lotes de parcelas completas, ~batchSize filas cada uno.
    const lotes: { refs: string[]; filas: TypologyRow[] }[] = [];
    let refs: string[] = [];
    let filas: TypologyRow[] = [];
    for (const [ref, rs] of porParcela) {
      refs.push(ref);
      filas.push(...rs);
      if (filas.length >= this.batchSize) {
        lotes.push({ refs, filas });
        refs = [];
        filas = [];
      }
    }
    if (filas.length > 0) lotes.push({ refs, filas });

    let inserted = 0;
    let errors = 0;
    for (const lote of lotes) {
      const { error: delErr } = await client
        .from("building_typologies")
        .delete()
        .in("parcel_ref", lote.refs);
      if (delErr) {
        console.error(`  ⚠️  Error limpiando lote de tipologías: ${delErr.message}`);
      }
      const res = await this.insertTypologyBatch(lote.filas);
      inserted += res.inserted;
      errors += res.errors;
      if (inserted % this.progressEvery < this.batchSize) {
        process.stdout.write(
          `  ... ${inserted.toLocaleString("es-ES")} tipologías cargadas\n`,
        );
      }
    }
    return { inserted, errors };
  }

  private async insertTypologyBatch(batch: TypologyRow[]): Promise<{
    inserted: number;
    errors: number;
  }> {
    const client = this.requireClient();
    // Retry con backoff: 0s → 2s → 5s → fail. Mitiga statement timeouts
    // transitorios de Supabase observados en Málaga.
    const delays = [0, 2000, 5000];
    let lastError: { message: string } | null = null;
    for (let attempt = 0; attempt < delays.length; attempt++) {
      if (delays[attempt] > 0) await new Promise((r) => setTimeout(r, delays[attempt]));
      const { error } = await client.from("building_typologies").insert(batch);
      if (!error) return { inserted: batch.length, errors: 0 };
      lastError = error;
      if (attempt < delays.length - 1) {
        console.error(`  ↻ Reintento lote de tipologías tras error: ${error.message}`);
      }
    }
    console.error(`  ⚠️  Error lote de tipologías (3 intentos): ${lastError?.message}`);
    return { inserted: 0, errors: batch.length };
  }

  /**
   * Elimina edificios y sus tipologías. Se usa con las parcelas que, tras el
   * agrupamiento por bien inmueble, caen por debajo del umbral de unidades:
   * dejaban de escribirse pero su fila antigua sobrevivía, así que la app
   * seguía sirviendo el desglose viejo y erróneo.
   *
   * ⚠️ El conjunto SIEMPRE se deriva de lo leído en el fichero de esta
   * corrida. Nunca de una consulta a la base: así es imposible que alcance a
   * una parcela que esta corrida no ha procesado.
   */
  async deleteBuildings(parcelRefs: string[]): Promise<{ deleted: number }> {
    if (this.dryRun || parcelRefs.length === 0) {
      return { deleted: parcelRefs.length };
    }
    const client = this.requireClient();
    const chunk = 500;
    let deleted = 0;
    for (let i = 0; i < parcelRefs.length; i += chunk) {
      const refs = parcelRefs.slice(i, i + chunk);
      // Primero las tipologías: si hay FK, el edificio no se puede borrar antes.
      const { error: tErr } = await client
        .from("building_typologies")
        .delete()
        .in("parcel_ref", refs);
      if (tErr) {
        console.error(`  ⚠️  Error borrando tipologías obsoletas: ${tErr.message}`);
      }
      const { error: bErr } = await client
        .from("buildings")
        .delete()
        .in("parcel_ref", refs);
      if (bErr) {
        console.error(`  ⚠️  Error borrando edificios obsoletos: ${bErr.message}`);
      } else {
        deleted += refs.length;
      }
    }
    return { deleted };
  }


  async countBuildings(): Promise<number> {
    if (this.dryRun) return 0;
    const client = this.requireClient();
    const { count, error } = await client
      .from("buildings")
      .select("*", { count: "exact", head: true });
    if (error) {
      console.error(`  ⚠️  Error contando buildings: ${error.message}`);
      return 0;
    }
    return count ?? 0;
  }

  async countTypologies(): Promise<number> {
    if (this.dryRun) return 0;
    const client = this.requireClient();
    const { count, error } = await client
      .from("building_typologies")
      .select("*", { count: "exact", head: true });
    if (error) {
      console.error(`  ⚠️  Error contando tipologías: ${error.message}`);
      return 0;
    }
    return count ?? 0;
  }

  async sampleBuilding(): Promise<Record<string, unknown> | null> {
    if (this.dryRun) return null;
    const client = this.requireClient();
    const { count } = await client
      .from("buildings")
      .select("*", { count: "exact", head: true });
    const total = count ?? 0;
    if (total === 0) return null;
    const offset = Math.floor(Math.random() * total);
    const { data, error } = await client
      .from("buildings_full")
      .select("*")
      .range(offset, offset);
    if (error) {
      console.error(`  ⚠️  Error sample: ${error.message}`);
      return null;
    }
    return data?.[0] ?? null;
  }
}

export function parseSourceDateFromHeader(fechaGeneracion: string): string {
  const d = fechaGeneracion.slice(0, 8);
  if (d.length === 8 && /^\d{8}$/.test(d)) {
    return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  }
  const today = new Date();
  return today.toISOString().slice(0, 10);
}
