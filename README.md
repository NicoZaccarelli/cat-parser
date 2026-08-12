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

Lo normal es cargar una provincia entera, no municipios a mano:

```powershell
# provincia completa
.\scripts\load-provincia.ps1 -Provincia soria -GzDir "E:\canScan\cat\Soria\42_U_23012026_CAT"

# ensayo: procesa y cuenta, no toca Supabase
.\scripts\load-provincia.ps1 -Provincia soria -GzDir "..." -DryRun

# solo unos municipios (p. ej. los que quedaron pendientes)
.\scripts\load-provincia.ps1 -Provincia soria -GzDir "..." -SoloCodigos 42001U,42002U
```

Descomprime, carga, escribe un CSV con un estado por municipio y reencola lo
que falla. Los estados están documentados en la cabecera del script; el que
importa vigilar es **`SIN_CARGA`**: había algo que cargar y no se cargó nada.

Para un fichero suelto:

```bash
# inspección, sin escribir nada
node node_modules/tsx/dist/cli.mjs src/index.ts <ruta/al/fichero.CAT>

# búsqueda de una parcela
node node_modules/tsx/dist/cli.mjs src/index.ts <fichero.CAT> --search <REFCAT14>

# ensayo de carga
node node_modules/tsx/dist/cli.mjs src/index.ts <fichero.CAT> --load --dry-run

# carga real
node node_modules/tsx/dist/cli.mjs src/index.ts <fichero.CAT> --load

# solo un subconjunto de parcelas (una por línea en el fichero)
node node_modules/tsx/dist/cli.mjs src/index.ts <fichero.CAT> --load --only-parcels refs.txt

# censo global de la base — CARO, una vez por provincia, nunca por municipio
node node_modules/tsx/dist/cli.mjs src/index.ts <fichero.CAT> --load --census
```

`npx tsx` funciona igual pero cuesta 1,54 s por invocación en vez de 0,49 s:
casi todo es npx resolviendo el paquete. Sobre 8.393 municipios son 2,4 h.

Madrid capital necesita `NODE_OPTIONS=--max-old-space-size=10240`.
`load-provincia.ps1` ya lo pone.

## Estado

**Soria validada con `load-provincia.ps1` el 12-08-2026.** 183 municipios de
una tacada, sin intervención:

```
OK          164   89,6 %
VACIO        19   10,4 %      ninguna parcela llega a 3 unidades
PARCIAL       0
SIN_CARGA     0
ABORTADO      0
FALLIDO       0

7.705 edificios · 34.671 tipologías
391,6 s de proceso  ·  media 2,14 s  ·  mediana 1,30 s  ·  máximo 62,8 s
```

Cero descuadres entre lo esperado y lo cargado, cero municipios con
`errores_lote > 0`, y nadie se acercó al corte de 180 s. En junio la misma
provincia tardó **62,5 minutos**; ahora tarda **9,6**.

Verificado además contra el CAT de origen: las 16 categorías de uso de Soria
cuadran fila a fila con lo que produce el pipeline actual. Cero desajustes.

### ⚠️ La base se encoge al reingerir

Soria pasó de **34.160 edificios y 114.073 tipologías** (junio) a **7.705 y
34.671** (hoy). No se ha perdido nada: el agrupamiento por bien inmueble
fusiona filas de construcción en unidades, así que muchas más parcelas caen
bajo el umbral de 3 unidades y dejan de ser "edificio con desglose". Sus
fichas pasan a resolverse por el flujo DNPRC, que es el correcto para ellas.

Es un factor **4,4× a la baja** en una provincia rural. Cuenta con que la
reingesta nacional reduzca el volumen de `buildings` y `building_typologies`
en el mismo orden de magnitud, y no lo confundas con pérdida de datos.

## Coste de una reingesta

La corrida nacional de junio-julio de 2026 tardó **101,4 h** de reloj: 94,4 h
medidas por el propio script más 7,0 h de `Start-Sleep`. De aquello, muy poco
era trabajo:

| se fue en | coste | qué era |
|---|---|---|
| censo global por municipio | ~35 h | dos `COUNT` sobre tablas de millones y una lectura con `OFFSET` aleatorio, de las que dos expiraban **siempre** |
| `Start-Sleep 3` entre municipios | 7,0 h | mitigación de una cascada de memoria que `1e99a08` ya había resuelto por otra vía |
| resolución de `npx` en cada arranque | ~2,4 h | 1,54 s por municipio en vez de 0,49 s |
| municipios reintentando contra Supabase | ~12 h | 21 municipios pasaron de 600 s; uno de 37 KB estuvo **8,3 h** |

Todo eso está corregido. El censo vive tras `--census` y corre una vez por
provincia; el sleep está en 250 ms; el arranque llama a `node` con el `tsx`
local; y el corte de 180 s mata y reencola lo que se atasca en la red.

### Estimación nacional, sobre datos medidos

Dos anclas independientes, y coinciden:

| ancla | GB comprimidos | tiempo | s/GB |
|---|---|---|---|
| Soria, 183 municipios (12-08-2026, script nuevo) | 0,019 | 391,6 s | 20.610 |
| Madrid capital, 1 municipio (junio) | 0,158 | 3.180 s | 20.152 |

Que la provincia más pequeña y rural y el municipio más denso de España den
el mismo rendimiento por GB es la mejor señal de que el coste lo manda el
volumen del fichero y no la estructura.

Sobre los **3,87 GB** de `.CAT.gz` del inventario completo:

```
proceso   3,87 GB × ~20.400 s/GB  ≈  21,9 h
sleep     8.392 × 250 ms          ≈   0,6 h
                                  ─────────
                                     ~22,5 h
```

Frente a las 101,4 h de junio. La banda razonable es **20-28 h**: la latencia
de Supabase es el factor que no controlamos, y basta un puñado de municipios
tocando el corte de 180 s para mover el total una hora.

Los cuatro forales van aparte y no cuentan aquí: no parten de ficheros CAT.

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
| `scripts/load-provincia.ps1` | cargador de una provincia CAT, con estados y reintentos |
| `scripts/load-{alava,bizkaia,gipuzkoa,navarra}.ps1` | forales: entrypoint propio, no parten de CAT |

## Fuente y atribución

Datos de la Dirección General del Catastro, del Ministerio de Hacienda y
Función Pública. La fecha del dato la declara el registro de cabecera de cada
fichero y viaja hasta la ficha; no se sustituye por la fecha de carga.

El pipeline no redistribuye el fichero original: agrega por tipología. No
extrae titulares ni valores catastrales, y no persiste referencias catastrales
de bien individual (20 caracteres) — la clave es siempre la parcela, de 14.
