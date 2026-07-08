-- ============================================================
-- Migración FASE 1 foral (Bizkaia) — bloque 1: setup base
-- Fecha aplicada: 2026-07-07
-- Autor: fichia — feat/foral-bizkaia
-- Reglas: 100% aditiva, sin DROP/RENAME, sin regresión DGC.
-- ============================================================

-- 1) Añadir columna source en buildings.
-- Todas las filas existentes heredan 'DGC' por default → sin cambios visibles.
ALTER TABLE buildings
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'DGC';

CREATE INDEX IF NOT EXISTS idx_buildings_source ON buildings(source);


-- 2) Recrear vista buildings_full con source AL FINAL.
-- Postgres exige que columnas existentes conserven orden en CREATE OR REPLACE VIEW.
-- `source` es la NUEVA última columna → no rompe consumidores por posición.
CREATE OR REPLACE VIEW buildings_full AS
SELECT
  b.parcel_ref, b.address, b.municipality, b.province,
  b.year_built, b.total_units, b.lat, b.lng, b.source_date, b.loaded_at,
  COALESCE(
    json_agg(
      json_build_object(
        'use_category', t.use_category,
        'typology_name', t.typology_name,
        'm2_avg', t.m2_avg,
        'm2_min', t.m2_min,
        'm2_max', t.m2_max,
        'unit_count', t.unit_count,
        'floors', t.floors
      ) ORDER BY t.use_category, t.typology_name
    ) FILTER (WHERE t.id IS NOT NULL),
    '[]'::json
  ) AS typologies,
  b.source
FROM buildings b
LEFT JOIN building_typologies t ON b.parcel_ref = t.parcel_ref
GROUP BY b.parcel_ref;


-- 3) PostGIS + tabla parcel_geometries.
-- Guarda geometrías de EDIFICIO (no de parcela) en EPSG:4326 para foto→GPS.
-- Reproyección 25830→4326 se hace EN CARGA (loader), no en consulta.
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS parcel_geometries (
  foral_id     TEXT PRIMARY KEY,
  source       TEXT NOT NULL,
  municipality TEXT NOT NULL,
  geom         geometry(MultiPolygon, 4326) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_parcel_geometries_geom
  ON parcel_geometries USING GIST (geom);

-- Índice geography para ST_DWithin / ST_Distance en metros (nearest fallback).
-- Añadido tras verificar EXPLAIN ANALYZE con 88k geometrías (avg 89ms/query).
CREATE INDEX IF NOT EXISTS idx_parcel_geometries_geog
  ON parcel_geometries USING GIST (((geom)::geography));

-- RLS habilitada en Supabase Studio (policy SELECT anon/authenticated USING true).
-- Los INSERT del loader van con SUPABASE_SERVICE_KEY (bypass RLS).

GRANT SELECT ON parcel_geometries TO anon;
GRANT SELECT ON parcel_geometries TO authenticated;


-- 4) RPC v1: find_parcel_by_point (ST_Contains estricto).
-- Se mantiene por compatibilidad. La app usa la v2 con fallback.
CREATE OR REPLACE FUNCTION find_parcel_by_point(
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION
) RETURNS TABLE (foral_id TEXT, source TEXT, municipality TEXT) AS $$
  SELECT g.foral_id, g.source, g.municipality
  FROM parcel_geometries g
  WHERE ST_Contains(g.geom, ST_SetSRID(ST_MakePoint(lng, lat), 4326))
  LIMIT 1;
$$ LANGUAGE SQL STABLE;

GRANT EXECUTE ON FUNCTION find_parcel_by_point(DOUBLE PRECISION, DOUBLE PRECISION) TO anon;
GRANT EXECUTE ON FUNCTION find_parcel_by_point(DOUBLE PRECISION, DOUBLE PRECISION) TO authenticated;
