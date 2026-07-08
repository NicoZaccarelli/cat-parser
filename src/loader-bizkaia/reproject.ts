// Reproyección EPSG:25830 (ETRS89 UTM 30N, usado en Bizkaia GML)
// → EPSG:4326 (WGS84, lat/lng). Wrap fino sobre proj4.

import proj4 from "proj4";

// Definición ETRS89 UTM 30N (EPSG:25830). WGS84 (EPSG:4326) es built-in.
proj4.defs(
  "EPSG:25830",
  "+proj=utm +zone=30 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs",
);

const from25830 = proj4("EPSG:25830", "EPSG:4326");

/**
 * Reproyecta un punto (x, y) de 25830 a WGS84 (lng, lat).
 */
export function project25830To4326(x: number, y: number): [number, number] {
  // proj4 devuelve [lng, lat] cuando el destino es EPSG:4326.
  const [lng, lat] = from25830.forward([x, y]);
  return [lng, lat];
}

/**
 * Parsea un `gml:posList` (string con "x1 y1 x2 y2 ...") y devuelve
 * la lista de puntos en 25830.
 */
export function parsePosList(posList: string): [number, number][] {
  const nums = posList.trim().split(/\s+/).map(Number);
  const pts: [number, number][] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) {
    pts.push([nums[i], nums[i + 1]]);
  }
  return pts;
}

/**
 * Centroide simple de un polígono cerrado (fórmula del Shoelace).
 * Recibe puntos en 25830, devuelve centroide en 25830.
 * Si el polígono es degenerado (área 0), fallback a media aritmética.
 */
export function centroidOfPolygon25830(
  ring: [number, number][],
): [number, number] {
  if (ring.length < 3) {
    // fallback: promedio
    const [sx, sy] = ring.reduce(
      ([ax, ay], [x, y]) => [ax + x, ay + y] as [number, number],
      [0, 0] as [number, number],
    );
    return [sx / Math.max(1, ring.length), sy / Math.max(1, ring.length)];
  }
  let cx = 0,
    cy = 0,
    a = 0;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[(i + 1) % n];
    const cross = x0 * y1 - x1 * y0;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
    a += cross;
  }
  a = a / 2;
  if (Math.abs(a) < 1e-9) {
    // área ~0 → fallback promedio
    const [sx, sy] = ring.reduce(
      ([ax, ay], [x, y]) => [ax + x, ay + y] as [number, number],
      [0, 0] as [number, number],
    );
    return [sx / n, sy / n];
  }
  return [cx / (6 * a), cy / (6 * a)];
}

/**
 * Helper todo-en-uno: posList (25830) → centroide en WGS84 (lat, lng).
 */
export function centroidWGS84(posList: string): { lat: number; lng: number } {
  const ring = parsePosList(posList);
  const [cx, cy] = centroidOfPolygon25830(ring);
  const [lng, lat] = project25830To4326(cx, cy);
  return { lat, lng };
}

/**
 * Convierte una lista de posList (multi-polígono simple, un solo ring exterior por parte)
 * a WKT MULTIPOLYGON en WGS84 para insertar en PostGIS.
 *
 * Formato: MULTIPOLYGON(((lng lat, lng lat, ...)), ((...)))
 * Cada elemento de `rings` es el `posList` de un exterior ring.
 */
export function ringsToMultiPolygonWKT(rings: string[]): string {
  const parts = rings
    .map((posList) => {
      const pts = parsePosList(posList);
      if (pts.length < 3) return null;
      // asegurar ring cerrado
      const first = pts[0];
      const last = pts[pts.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) pts.push(first);
      const coords = pts
        .map(([x, y]) => {
          const [lng, lat] = project25830To4326(x, y);
          return `${lng.toFixed(7)} ${lat.toFixed(7)}`;
        })
        .join(", ");
      return `((${coords}))`;
    })
    .filter((s): s is string => s !== null);
  if (parts.length === 0) return "MULTIPOLYGON EMPTY";
  return `MULTIPOLYGON(${parts.join(", ")})`;
}
