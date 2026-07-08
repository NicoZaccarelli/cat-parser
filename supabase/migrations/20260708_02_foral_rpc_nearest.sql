-- ============================================================
-- Migración FASE 1 foral (Bizkaia) — bloque 2: RPC con fallback nearest
-- Fecha aplicada: 2026-07-07
-- Autor: fichia — feat/foral-bizkaia
-- Reglas: 100% aditiva (nueva función; la v1 sigue existiendo).
--
-- Motivación: GPS del usuario en la acera → ST_Contains estricto devuelve 0.
-- Este RPC v2 prueba primero contains, y si vacío, busca el edificio más
-- cercano dentro de un radio configurable (default 30m). Devuelve también
-- distance_m + hit_type para que la app pida confirmación si es ambigua.
--
-- Benchmark: avg 89ms sobre 88k geometrías (Bizkaia).
-- ============================================================

CREATE OR REPLACE FUNCTION find_parcel_by_point_or_nearest(
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  p_max_meters DOUBLE PRECISION DEFAULT 30.0
) RETURNS TABLE (
  foral_id     TEXT,
  source       TEXT,
  municipality TEXT,
  distance_m   DOUBLE PRECISION,
  hit_type     TEXT   -- 'contains' | 'nearest'
) AS $$
WITH pt AS (
  SELECT ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography AS g_geog,
         ST_SetSRID(ST_MakePoint(lng, lat), 4326)             AS g_geom
),
contains_hit AS (
  SELECT g.foral_id, g.source, g.municipality,
         0.0::DOUBLE PRECISION AS distance_m,
         'contains'::TEXT      AS hit_type
  FROM parcel_geometries g, pt
  WHERE ST_Contains(g.geom, pt.g_geom)
  LIMIT 1
),
nearest_hit AS (
  SELECT g.foral_id, g.source, g.municipality,
         ST_Distance(g.geom::geography, pt.g_geog) AS distance_m,
         'nearest'::TEXT AS hit_type
  FROM parcel_geometries g, pt
  WHERE NOT EXISTS (SELECT 1 FROM contains_hit)
    AND ST_DWithin(g.geom::geography, pt.g_geog, p_max_meters)
  ORDER BY g.geom::geography <-> pt.g_geog
  LIMIT 1
)
SELECT * FROM contains_hit
UNION ALL
SELECT * FROM nearest_hit;
$$ LANGUAGE SQL STABLE;

GRANT EXECUTE ON FUNCTION find_parcel_by_point_or_nearest(DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION) TO anon;
GRANT EXECUTE ON FUNCTION find_parcel_by_point_or_nearest(DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION) TO authenticated;
