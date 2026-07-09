// Parser CSV streaming para los ficheros alfanuméricos de GFA (Gipuzkoa).
//
// Formato:
//   - Encoding: LATIN-1 (Windows-1252 en la práctica).
//   - Separador: ";".
//   - Line endings: CRLF.
//   - Coma decimal española: "178,00" para 178.00 m².
//   - Cabeceras: pueden tener espacios de relleno (ej. "N.Fijo " con trailing
//     space); se trimean.
//
// Diseño: readStream + iconv-lite decode LATIN-1 → líneas → parse manual
// (no usamos csv-parser porque el CRLF/latin1 combinados dan menos problemas
// con parse manual y evitamos deps).

import * as fs from "node:fs";
import * as iconv from "iconv-lite";

export interface CsvRow {
  [column: string]: string;
}

/**
 * Parsea `superfic.` (string GFA) a number.
 * Formato: "   178,00" o "1234,56". Coma decimal, padding a la izquierda.
 */
export function parseGfaSuperficie(raw: string): number {
  if (!raw) return 0;
  const t = raw.trim().replace(",", ".");
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Parsea FeFinObr (YYYYMMDD como texto) a año.
 * "19000101" es un placeholder oficial GFA para "sin datos" → devuelve null.
 */
export function parseGfaFecha(raw: string): number | null {
  if (!raw) return null;
  const t = raw.trim();
  if (t.length < 4) return null;
  const year = parseInt(t.slice(0, 4), 10);
  if (!Number.isFinite(year) || year < 1900 || year > 2100) return null;
  // 1900-01-01 es placeholder GFA — el catastro lo usa para "sin dato"
  if (year === 1900 && t.slice(4) === "0101") return null;
  return year;
}

/**
 * Lee un CSV GFA y llama a `onRow` para cada fila. Cabeceras trimeadas.
 * Retorna nº de filas procesadas (excluyendo header).
 */
export async function streamCsv(
  path: string,
  onRow: (row: CsvRow) => void,
): Promise<number> {
  const buffer = fs.readFileSync(path);
  const text = iconv.decode(buffer, "latin1");
  // Split por CRLF o LF.
  const lines = text.split(/\r?\n/);
  if (lines.length === 0) return 0;

  const headers = lines[0].split(";").map((h) => h.trim());
  let count = 0;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.trim() === "") continue;
    const cols = line.split(";");
    const row: CsvRow = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = cols[j] ?? "";
    }
    onRow(row);
    count++;
  }
  return count;
}

/**
 * Concatena múltiples CSVs (Donostia tiene "Datos de los locales.csv",
 * "Datos de los locales-2.csv", -3, -4) tratándolos como un solo dataset.
 * Solo el primer fichero aporta cabecera; los demás se streamean con las
 * mismas cabeceras.
 *
 * NOTE: el archivo -2 puede tener su propia cabecera al principio (GFA la
 * incluye por si el fichero se abre standalone). Se detecta y salta si
 * la primera línea del -2 es idéntica a la del principal.
 */
export async function streamCsvGroup(
  paths: string[],
  onRow: (row: CsvRow) => void,
): Promise<number> {
  if (paths.length === 0) return 0;
  const buffer0 = fs.readFileSync(paths[0]);
  const text0 = iconv.decode(buffer0, "latin1");
  const lines0 = text0.split(/\r?\n/);
  const headers = lines0[0].split(";").map((h) => h.trim());
  const headerLine = lines0[0].trim();

  let total = 0;
  const processLines = (lines: string[], skipHeaderIfMatch: boolean) => {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line || line.trim() === "") continue;
      if (i === 0 && skipHeaderIfMatch && line.trim() === headerLine) continue;
      if (i === 0 && !skipHeaderIfMatch) continue; // skip header of first file
      const cols = line.split(";");
      const row: CsvRow = {};
      for (let j = 0; j < headers.length; j++) {
        row[headers[j]] = cols[j] ?? "";
      }
      onRow(row);
      total++;
    }
  };

  processLines(lines0, false);
  for (let k = 1; k < paths.length; k++) {
    const buf = fs.readFileSync(paths[k]);
    const txt = iconv.decode(buf, "latin1");
    const lns = txt.split(/\r?\n/);
    processLines(lns, true);
  }
  return total;
}
