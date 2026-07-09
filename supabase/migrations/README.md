# Migraciones Supabase — cat-parser + fichia foral

Cada archivo es un bloque SQL **idempotente** (`IF NOT EXISTS` / `CREATE OR REPLACE`),
aplicable con Supabase Studio → SQL Editor → Run.

## Historial

| Archivo | Fecha aplicada | Rama | Descripción |
|---------|---------------|------|-------------|
| [../schema.sql](../schema.sql) | Genesis | main | Tablas base `buildings` + `building_typologies` + vista `buildings_full`. |
| [20260708_01_foral_bizkaia_base.sql](20260708_01_foral_bizkaia_base.sql) | 2026-07-07 | feat/foral-bizkaia | `source` column, vista recreada, PostGIS + `parcel_geometries` + RPC v1. |
| [20260708_02_foral_rpc_nearest.sql](20260708_02_foral_rpc_nearest.sql) | 2026-07-07 | feat/foral-bizkaia | RPC v2 con fallback nearest (ST_DWithin 30m default). |
| [20260710_03_foral_get_geometry.sql](20260710_03_foral_get_geometry.sql) | 2026-07-10 | feat/foral-gipuzkoa | RPC `get_foral_parcel_geometry(foral_id) → TEXT GeoJSON` para pintar polígono en fichas foral. |

## Reglas

1. **Solo aditivas**: `ADD COLUMN`, `CREATE TABLE`, `CREATE FUNCTION`, `CREATE INDEX`.
   Prohibido `DROP` / `RENAME` / `ALTER TYPE` sobre columnas DGC existentes.
2. **RLS**: nuevas tablas heredan RLS habilitada de Supabase por default; añadir
   policies SELECT explícitas para `anon` y `authenticated`. INSERT/UPDATE via
   `SUPABASE_SERVICE_KEY` (bypass RLS).
3. Al aplicar, verificar `SELECT COUNT(*) FROM buildings WHERE source='DGC'` sin cambio.
