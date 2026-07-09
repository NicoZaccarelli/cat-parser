-- ============================================================
-- Migración FASE 2 foral (Gipuzkoa) — bloque 3: RPC geometría GeoJSON
-- Fecha aplicada: 2026-07-10
-- Autor: fichia — feat/foral-gipuzkoa
-- Reglas: 100% aditiva (nueva función; ninguna existente se toca).
--
-- Motivación: las fichas foral (BFA/GFA) no pintaban el polígono de
-- parcela en el mapa Leaflet porque `handleForalRequest` devolvía
-- `geometry: null`. El flow DGC obtiene la geometría del WFS del
-- Catastro; foral la lee de `parcel_geometries` con este RPC.
--
-- Salida: string GeoJSON listo para JSON.parse en el servidor + pasar
-- como prop a <GeoJSON data={...}/> de leaflet-react.
-- ============================================================

CREATE OR REPLACE FUNCTION get_foral_parcel_geometry(p_foral_id TEXT)
RETURNS TEXT AS $$
  SELECT ST_AsGeoJSON(geom)::TEXT
  FROM parcel_geometries
  WHERE foral_id = p_foral_id
  LIMIT 1;
$$ LANGUAGE SQL STABLE;

GRANT EXECUTE ON FUNCTION get_foral_parcel_geometry(TEXT) TO anon;
GRANT EXECUTE ON FUNCTION get_foral_parcel_geometry(TEXT) TO authenticated;
