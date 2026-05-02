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
    this.batchSize = opts.batchSize ?? 500;
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

  async clearTypologiesFor(parcelRefs: string[]): Promise<void> {
    if (this.dryRun) return;
    const client = this.requireClient();
    const chunk = 500;
    for (let i = 0; i < parcelRefs.length; i += chunk) {
      const refs = parcelRefs.slice(i, i + chunk);
      const { error } = await client
        .from("building_typologies")
        .delete()
        .in("parcel_ref", refs);
      if (error) {
        console.error(`  ⚠️  Error limpiando tipologías: ${error.message}`);
      }
    }
  }

  async loadTypologies(rows: TypologyRow[]): Promise<{
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
      const { error } = await client.from("building_typologies").insert(batch);
      if (error) {
        errors += batch.length;
        console.error(
          `  ⚠️  Error batch tipologías [${i}-${i + batch.length}]: ${error.message}`,
        );
      } else {
        inserted += batch.length;
      }
      if (inserted % this.progressEvery < this.batchSize) {
        process.stdout.write(
          `  ... ${inserted.toLocaleString("es-ES")} tipologías cargadas\n`,
        );
      }
    }
    return { inserted, errors };
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
