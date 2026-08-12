# cat-parser

Ingesta de los ficheros CAT de la Dirección General del Catastro a Supabase:
parcelas → bienes inmuebles → tipologías agregadas por uso y superficie.
Incluye además los cargadores forales (Bizkaia, Gipuzkoa, Navarra, Álava),
que parten de formatos propios y no del CAT.

---

> ## Antes de reingerir: comprueba en qué commit estás
>
> El agrupamiento por bien inmueble entró en `main` el **12-08-2026**, con el
> merge `30a5209`. Cualquier checkout anterior produce datos incorrectos.
>
> El fallo no avisa: los ficheros se cargan, el script dice OK y la base queda
> con el doble de viviendas de la mitad de superficie, cada una valorada a la
> mitad. Un bien inmueble repartido en varias plantas se parte en una unidad
> por planta — 32 dúplex salen como 64 pisos. Verificado en Santa Prisca 2
> (Madrid).
>
> ```
> git -C D:\canScan\cat-parser merge-base --is-ancestor 30a5209 HEAD \
>   && echo "OK: incluye el agrupamiento por bien inmueble" \
>   || echo "PELIGRO: este checkout es anterior. Actualiza antes de cargar."
> ```
>
> `scripts/load-provincia.ps1` hace esta comprobación por su cuenta y aborta
> si no se cumple, así que la vía normal está cubierta. Este recordatorio es
> para quien invoque `src/index.ts --load` a mano.

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
