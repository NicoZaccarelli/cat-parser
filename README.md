# cat-parser

Ingesta de los ficheros CAT de la Dirección General del Catastro a Supabase:
parcelas → bienes inmuebles → tipologías agregadas por uso y superficie.
Incluye además los cargadores forales (Bizkaia, Gipuzkoa, Navarra, Álava),
que parten de formatos propios y no del CAT.

---

> # ⛔ NO REINGIERAS DESDE `main`
>
> **`main` está congelada en el estado de mayo de 2026 y produce datos
> incorrectos.** Le faltan siete commits que viven en
> `fix/agrupar-por-bien-inmueble`, entre ellos el arreglo del bug del dúplex.
>
> Cargar una provincia desde `main` **regenera ese bug**: cada bien inmueble
> repartido en varias plantas se parte en una unidad por planta, así que un
> edificio de 32 dúplex sale con 64 viviendas de la mitad de superficie y cada
> una se valora a la mitad. Verificado en Santa Prisca 2 (Madrid).
>
> **Usa `fix/agrupar-por-bien-inmueble` o una rama construida encima de ella**
> hasta que el merge esté hecho. Comprueba en qué rama estás antes de lanzar
> nada:
>
> ```
> git -C D:\canScan\cat-parser rev-parse --abbrev-ref HEAD
> ```
>
> Los siete commits pendientes:
>
> | commit | qué aporta |
> |---|---|
> | `aacaaee` | `m2_avg_construida` por tipología y la opción `--only-parcels` |
> | `9cbe4a3` | documenta que `m2MedioConstruida` está dormido en Madrid capital |
> | `d6a189b` | **el arreglo del dúplex**: una unidad por bien inmueble, no por fila de construcción |
> | `4d73822` | superficie construida desde el registro 15 (442-451), que sustituye a las posiciones 98-104 del registro 14 |
> | `9fe0b1a` | gate de validación del layout: aborta antes de escribir si el fichero no cuadra |
> | `1e99a08` | buffer de una sola parcela en el agrupador; sin él Madrid capital agota el heap |
> | `ce2d844` | borra las parcelas que caen bajo el umbral y escribe lote a lote |
>
> Este aviso se retira cuando `main` los contenga.

---

## Uso

```bash
# inspección, sin escribir nada
npx tsx src/index.ts <ruta/al/fichero.CAT>

# búsqueda de una parcela
npx tsx src/index.ts <fichero.CAT> --search <REFCAT14>

# ensayo de carga: procesa y cuenta, pero no toca Supabase
npx tsx src/index.ts <fichero.CAT> --load --dry-run

# carga real
npx tsx src/index.ts <fichero.CAT> --load

# solo un subconjunto de parcelas (una por línea en el fichero)
npx tsx src/index.ts <fichero.CAT> --load --only-parcels refs.txt
```

Madrid capital necesita `NODE_OPTIONS=--max-old-space-size=10240`. Los
scripts de `scripts/` ya lo ponen.

## Estructura

| ruta | qué hace |
|---|---|
| `src/parser/` | lectura del CAT y troceado posicional de los registros 01/11/13/14/15 |
| `src/transformer/grouper.ts` | parcelas → unidades, agrupando por bien inmueble |
| `src/transformer/typologizer.ts` | unidades → tipologías por uso y rango de superficie |
| `src/transformer/validationGate.ts` | comprueba que el layout del fichero es el esperado; aborta si no |
| `src/loader/supabase.ts` | escritura por lotes en `buildings` y `building_typologies` |
| `src/loader-{bizkaia,gipuzkoa,navarra,alava}/` | forales, con formatos propios |
| `goldens/` | líneas base para diffear reingestas. Ver `goldens/README.md` |
| `scripts/` | un `load-<provincia>.ps1` por provincia |

## Fuente y atribución

Datos de la Dirección General del Catastro, del Ministerio de Hacienda y
Función Pública. La fecha del dato la declara el registro de cabecera de cada
fichero y viaja hasta la ficha; no se sustituye por la fecha de carga.

El pipeline no redistribuye el fichero original: agrega por tipología. No
extrae titulares ni valores catastrales, y no persiste referencias catastrales
de bien individual (20 caracteres) — la clave es siempre la parcela, de 14.
