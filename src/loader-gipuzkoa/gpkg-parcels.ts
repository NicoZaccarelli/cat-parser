// Lectura de geometrías de parcela desde el GeoPackage GFA_INSPIRE_CP.gpkg.
//
// SRS: EPSG:25830 (verificado en gpkg_contents.srs_id).
// Formato binario: GeoPackage WKB con cabecera propia:
//   bytes 0-1: magic "GP"
//   byte 2: version (0)
//   byte 3: flags (bit0 endian, bit1 empty, bits2-4 envelope type)
//   bytes 4-7: srid (int LE/BE según endian)
//   envelope opcional: 0/32/48/64 bytes según flags
//   resto: WKB estándar
//
// Extraemos el ring EXTERIOR del POLYGON y computamos el centroide en
// 25830, luego reproyectamos a 4326 con proj4 (mismo helper que Bizkaia).

import Database from "better-sqlite3";
import {
  centroidOfPolygon25830,
  project25830To4326,
  ringsToMultiPolygonWKT,
  parsePosList,
} from "../loader-bizkaia/reproject.js";

export interface ParcelRow {
  mun: string;         // "069" para Donostia
  referen: string;     // "8594095"
  areaValue: number;   // m² gráficos
  beginLifes: string;  // "2015/03/03"
  lat: number;
  lng: number;
  /** WKT MULTIPOLYGON en 4326 para insert en parcel_geometries. */
  wkt: string;
}

/**
 * Decodifica geom GeoPackage → array de rings (x/y en 25830).
 * Retorna solo el ring EXTERIOR del POLYGON (INSPIRE CP siempre es simple).
 */
function decodeGpkgPolygon(geom: Buffer): [number, number][] | null {
  if (geom.length < 8 || geom[0] !== 0x47 || geom[1] !== 0x50) return null; // no "GP"
  const flags = geom[3];
  const endian = flags & 0x01; // 0=big, 1=little
  // envelope size according to flags bits 2-4
  const envType = (flags >> 1) & 0x07;
  let envBytes = 0;
  if (envType === 1) envBytes = 32;
  else if (envType === 2 || envType === 3) envBytes = 48;
  else if (envType === 4) envBytes = 64;
  const wkbStart = 8 + envBytes;
  if (geom.length < wkbStart + 9) return null;

  // WKB standard
  const wkbEndian = geom[wkbStart]; // 0=BE, 1=LE
  const readU32 = (off: number) =>
    wkbEndian === 1 ? geom.readUInt32LE(off) : geom.readUInt32BE(off);
  const readDouble = (off: number) =>
    wkbEndian === 1 ? geom.readDoubleLE(off) : geom.readDoubleBE(off);

  const type = readU32(wkbStart + 1);
  if (type !== 3) return null; // 3 = Polygon
  const numRings = readU32(wkbStart + 5);
  if (numRings < 1) return null;

  let off = wkbStart + 9;
  // Solo leemos el ring exterior (primero).
  const numPoints = readU32(off);
  off += 4;
  const ring: [number, number][] = [];
  for (let i = 0; i < numPoints; i++) {
    const x = readDouble(off);
    const y = readDouble(off + 8);
    ring.push([x, y]);
    off += 16;
  }
  return ring;
}

/**
 * Devuelve un iterador de parcelas del gpkg (opcionalmente filtrado por
 * municipio). Cada parcela trae centroide reproyectado + WKT MULTIPOLYGON
 * en 4326 listo para insertar en parcel_geometries.
 */
export function readParcels(
  gpkgPath: string,
  mun?: string, // "069" para filtrar solo Donostia
): ParcelRow[] {
  const db = new Database(gpkgPath, { readonly: true });
  try {
    // INSPIREID formato: ES.GFA.CP.{mun}-{referen}-{checksum}
    const sql = mun
      ? `SELECT INSPIREID, NCADASTREF, AREAVALUE, BEGINLIFES, geom FROM GFA_INSPIRE_CP WHERE INSPIREID LIKE 'ES.GFA.CP.${mun}-%'`
      : `SELECT INSPIREID, NCADASTREF, AREAVALUE, BEGINLIFES, geom FROM GFA_INSPIRE_CP`;
    const rows = db.prepare(sql).all() as Array<{
      INSPIREID: string;
      NCADASTREF: string;
      AREAVALUE: number;
      BEGINLIFES: string;
      geom: Buffer;
    }>;

    const out: ParcelRow[] = [];
    for (const r of rows) {
      const parts = r.INSPIREID.split(".");
      const idPart = parts[parts.length - 1]; // "069-8594095-3232"
      const idParts = idPart.split("-");
      if (idParts.length < 2) continue;
      const munCode = idParts[0];
      const referen = idParts[1];

      const ring = decodeGpkgPolygon(r.geom);
      if (!ring || ring.length < 3) continue;

      const [cx, cy] = centroidOfPolygon25830(ring);
      const [lng, lat] = project25830To4326(cx, cy);

      // Construir WKT MULTIPOLYGON en 4326 (una sola polygon exterior).
      // Reusamos el helper de bizkaia pasándole el ring como posList.
      const posList = ring.map(([x, y]) => `${x} ${y}`).join(" ");
      const wkt = ringsToMultiPolygonWKT([posList]);

      out.push({
        mun: munCode,
        referen,
        areaValue: r.AREAVALUE,
        beginLifes: r.BEGINLIFES,
        lat,
        lng,
        wkt,
      });
    }
    return out;
  } finally {
    db.close();
  }
}

// Re-export para consumo directo del index si hace falta
export { parsePosList };
