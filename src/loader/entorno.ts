/**
 * Guarda de entorno: impedir que una carga de desarrollo escriba en la base
 * de PRODUCCIÓN por descuido.
 *
 * ─── Por qué aquí importa más que en la app ────────────────────────────────
 * El `.env` de este repo tiene solo SUPABASE_URL y SUPABASE_SERVICE_KEY, sin
 * ninguna marca de entorno, y la `service_role` key salta el RLS. Pero además
 * las operaciones de este proceso no son tres filas de telemetría:
 * `replaceTypologies` BORRA e inserta por parcela y `deleteBuildings` borra
 * las que caen bajo el umbral. Una provincia lanzada contra la base
 * equivocada no ensucia: destruye.
 *
 * ─── Por qué una TABLA y no la URL ─────────────────────────────────────────
 * La comprobación es POSITIVA: la base de desarrollo se identifica a sí misma
 * con una tabla `_entorno` que producción no tiene. Una lista de hosts
 * prohibidos se queda desactualizada y un `.env` mal copiado lleva la URL de
 * producción con toda naturalidad; una tabla que no existe no se puede
 * fingir. Y si no se puede comprobar, se aborta: el fallo por defecto es el
 * seguro.
 *
 * ─── La vía de escape ──────────────────────────────────────────────────────
 * Cargar en producción sigue siendo posible —es lo normal, de hecho— pero
 * exige un gesto deliberado: `PERMITIR_PRODUCCION=1`. Ese gesto es todo el
 * mecanismo: convierte un descuido en una decisión.
 */

export const TABLA_ENTORNO = "_entorno";
export const ESCAPE_ENV = "PERMITIR_PRODUCCION";

export type Entorno = "desarrollo" | "produccion" | "indeterminado";

export interface ResultadoEntorno {
  entorno: Entorno;
  motivo?: string;
}

/** Host sin credenciales, para poder enseñarlo en un log sin filtrar nada. */
export function hostDe(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "(url ilegible)";
  }
}

export function escapeActivo(): boolean {
  const v = process.env[ESCAPE_ENV];
  return v === "1" || v === "true";
}

export async function detectarEntorno(
  url: string,
  key: string,
): Promise<ResultadoEntorno> {
  if (!url || !key) return { entorno: "indeterminado", motivo: "faltan URL o key" };
  try {
    const r = await fetch(
      `${url.replace(/\/$/, "")}/rest/v1/${TABLA_ENTORNO}?select=nombre&limit=1`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } },
    );
    if (r.status === 404) return { entorno: "produccion" };
    if (!r.ok) {
      const cuerpo = await r.text();
      if (/42P01|does not exist|Could not find the table/i.test(cuerpo)) {
        return { entorno: "produccion" };
      }
      return { entorno: "indeterminado", motivo: `HTTP ${r.status}` };
    }
    const filas = (await r.json()) as Array<{ nombre?: string }>;
    if (Array.isArray(filas) && filas[0]?.nombre === "desarrollo") {
      return { entorno: "desarrollo" };
    }
    return {
      entorno: "indeterminado",
      motivo: `${TABLA_ENTORNO} existe pero no declara "desarrollo"`,
    };
  } catch (e) {
    return {
      entorno: "indeterminado",
      motivo: e instanceof Error ? e.message : "error de red",
    };
  }
}

/**
 * Aborta si la base no es la de desarrollo y no se ha puesto la vía de escape.
 *
 * ⚠️ El entorno INDETERMINADO también aborta. Si no se puede saber dónde se
 * va a escribir, el supuesto seguro es que es producción.
 */
export async function assertEntornoPermitido(
  url: string,
  key: string,
  contexto = "cat-parser",
): Promise<void> {
  const r = await detectarEntorno(url, key);
  if (r.entorno === "desarrollo") return;

  if (escapeActivo()) {
    console.warn(
      `⚠️  [${contexto}] Escribiendo en ${hostDe(url)} con ${ESCAPE_ENV} activo` +
        (r.entorno === "produccion" ? " — es PRODUCCIÓN." : ` — entorno ${r.entorno}.`),
    );
    return;
  }

  const detalle =
    r.entorno === "produccion"
      ? `la base NO tiene la tabla "${TABLA_ENTORNO}", así que es PRODUCCIÓN`
      : `no se pudo determinar el entorno (${r.motivo})`;

  throw new Error(
    `\n⛔ [${contexto}] Abortado antes de escribir nada: ${detalle}.\n` +
      `   Host: ${hostDe(url)}\n\n` +
      `   Una carga de provincia BORRA e inserta por parcela. Si de verdad\n` +
      `   quieres hacerlo contra esta base, dilo explícitamente:\n\n` +
      `     PowerShell:  $env:${ESCAPE_ENV}="1"; .\\scripts\\load-provincia.ps1 ...\n` +
      `     bash:        ${ESCAPE_ENV}=1 node ...\n`,
  );
}
