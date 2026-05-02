-- ============================================================================
-- cat-parser · Schema Supabase
-- Datos agregados del Catastro Español (FIN CAT 2006)
-- Fuente: Dirección General del Catastro (datos elaborados)
--
-- Reglas de licencia:
--   · NO cargar refcat de bien inmueble individual (20 chars)
--   · SOLO refcat de parcela (14 chars) + tipologías agregadas
--   · Unidades con planta "OM" (elementos comunes) se filtran antes de cargar
--   · Edificios con < 3 unidades habitables se descartan
-- ============================================================================

-- Tabla 1: Edificios (parcelas catastrales con al menos 3 unidades no-OM)
CREATE TABLE IF NOT EXISTS buildings (
  parcel_ref TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  municipality TEXT NOT NULL,
  province TEXT NOT NULL,
  year_built INT,
  total_units INT NOT NULL,
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  source_date DATE NOT NULL,
  loaded_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_buildings_municipality ON buildings(municipality);
CREATE INDEX IF NOT EXISTS idx_buildings_total_units ON buildings(total_units);

-- Tabla 2: Tipologías por edificio (sin refcat individuales, solo agregados)
CREATE TABLE IF NOT EXISTS building_typologies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parcel_ref TEXT NOT NULL REFERENCES buildings(parcel_ref) ON DELETE CASCADE,
  use_category TEXT NOT NULL,
  typology_name TEXT NOT NULL,
  m2_avg INT NOT NULL,
  m2_min INT NOT NULL,
  m2_max INT NOT NULL,
  unit_count INT NOT NULL,
  floors TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_typologies_parcel_ref ON building_typologies(parcel_ref);
CREATE INDEX IF NOT EXISTS idx_typologies_use ON building_typologies(use_category);

-- Vista: edificio + sus tipologías en un JSON (para consulta en un solo query)
CREATE OR REPLACE VIEW buildings_full AS
SELECT
  b.*,
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
  ) AS typologies
FROM buildings b
LEFT JOIN building_typologies t ON b.parcel_ref = t.parcel_ref
GROUP BY b.parcel_ref;
