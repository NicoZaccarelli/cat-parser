-- ============================================================
-- Migración IBI — m2_avg_construida (superficie con comunes)
-- Fecha: 2026-08-03
-- Autor: fichia — feat/ibi-m2-construida
-- Reglas: 100% aditiva, sin DROP/RENAME, sin regresión.
-- ============================================================
--
-- Añade la superficie media CONSTRUIDA por tipología (privativa + elementos
-- comunes imputados por coeficiente), base del VC/IBI. `m2_avg` (privativa)
-- queda intacto para los consumidores actuales (valoración de mercado, etc.).
--
-- Nullable: las filas anteriores a la reingesta y los edificios sin filas de
-- comunes se quedan en NULL (la app cae a m2_avg / oculta el IBI por guard).

ALTER TABLE building_typologies
  ADD COLUMN IF NOT EXISTS m2_avg_construida INT;

-- Recrear la vista añadiendo m2_avg_construida dentro del objeto de tipología.
-- Partimos de la definición VIGENTE (20260708_01, con `source` al final):
-- se conserva el orden de columnas de la vista; el nuevo campo va dentro del
-- json_build_object (el orden de claves del JSON no afecta a consumidores).
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
        'm2_avg_construida', t.m2_avg_construida,
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
