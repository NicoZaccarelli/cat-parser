# Goldens

Instantáneas del resultado del transformador **antes** de un cambio que puede
moverlo. No son datos de producto: son la línea base contra la que se diffea
una reingesta para distinguir "esto ha cambiado porque queríamos" de "esto ha
cambiado y no sabíamos".

Un golden solo sirve si se captura antes de tocar el código. Si te encuentras
generando uno después de un cambio, ya no es un golden: es una foto del
resultado nuevo.

---

## `madrid-viviendas-2026-01-23.ndjson`

Tipologías de **uso vivienda** de todas las parcelas de Madrid capital, con el
agrupamiento vigente en agosto de 2026.

```
sha256    7c4be92fd311e43af48ab80e224d4565ead67973403eb942f413188c4e0691ba
líneas    110.079  (una por parcela con al menos una vivienda)
tamaño    13,0 MB
```

### Fuente y fecha del dato

Dirección General del Catastro, del Ministerio de Hacienda y Función Pública.
Fichero de intercambio `28900U_23012026.CAT` (Madrid capital, régimen común).
**Fecha del dato catastral: 2026-01-23**, la que declara el registro de
cabecera del propio fichero.

Generado el 11-08-2026.

### Regla de agrupamiento con la que se generó

La que estaba en producción en esa fecha — `grouper.ts` + `typologizer.ts` en
la rama `fix/agrupar-por-bien-inmueble`:

1. **Una unidad por `(bien inmueble, primera letra del destino)`.** El bien
   inmueble son las posiciones 51-54 del registro 14; el destino, las 71-73.
   Un bien con recintos de dos destinos produce dos unidades.
2. **Superficie** = suma de las superficies totales (registro 14, 84-90) de
   los recintos que comparten esa clave.
3. **Planta** = la del recinto **más bajo** de la clave, con el orden de
   `plantaHeight` (`SS` −2, `SM` −1, `BJ`/`PB` 0, `EN` 0,5, `AT` 900, y las no
   reconocidas al final).
4. Se descartan los recintos sin bien inmueble (elementos comunes) y los de
   planta no numérica ni habitable (`isCommonElement`).
5. **Tipologías**: agrupación por superficie con tolerancia del **5 %**
   (`TOLERANCIA = 0.05`, comparada contra `rango / media ≤ 0,10`).

Solo se guarda el uso **Vivienda** (`usoChar === "V"`). Los demás usos quedan
fuera a propósito: son los que la Fase 2 va a reetiquetar, y mezclarlos haría
ilegible el diff.

### Formato

Una línea NDJSON por parcela:

```json
{"p":"9236504VK3793E","t":[{"t":"A","n":4,"m2":36,"pl":"01,02,03,04"}]}
```

| campo | significado |
|---|---|
| `p`  | referencia catastral de **parcela**, 14 caracteres |
| `t`  | tipologías, en el orden que las nombra el tipologizador |
| `t.t`  | letra de la tipología |
| `t.n`  | número de unidades |
| `t.m2` | superficie media privativa, redondeada |
| `t.pl` | plantas distintas presentes, ordenadas y separadas por coma |

### Cumplimiento DGC

- **Cero referencias catastrales de 20 caracteres.** Verificado: las 110.079
  claves son de 14 caracteres y no aparece ninguna cadena de 20 en ninguna
  posición del fichero. La clave es la parcela, nunca el bien individual.
- Sin titulares, sin valores catastrales, sin domicilios.
- Dato transformado (agregación por tipología), no redistribución del fichero
  original. Cláusulas 5, 6, 7, 8 y 12.

### Cómo usarlo

Regenerar con la misma regla sobre el mismo `.CAT` debe dar un fichero de
sha256 idéntico. Tras la Fase 2, el diff esperado se concentra en las
**18.959 parcelas** de `afectadas-fase2-madrid-2026-01-23.csv`. **Cualquier
movimiento en una parcela que no esté en esa lista es una regresión**, no una
mejora.

---

## `afectadas-fase2-madrid-2026-01-23.csv`

Las parcelas de Madrid capital cuya superficie de vivienda **cambia** con la
Fase 2. No es un golden: es la lista de trabajo del cambio y el filtro con el
que se lee su diff.

```
sha256    c0dfc2c3bd89cf9765cd70ecd623976985a42e8890a33fc524779e66739f8210
filas     18.959  (una por parcela, más la cabecera)
tamaño    481 KB
```

Generado el 12-08-2026 con `scripts/genera-afectadas-fase2.mjs` sobre
`28900U_23012026.CAT`, dato catastral de **2026-01-23**.

### Para qué existe

Dos usos, y conviene no confundirlos:

1. **Filtrar el diff del golden** tras reingerir Madrid. Lo que se mueva fuera
   de esta lista no lo ha movido la Fase 2.
2. **Cargarla en `afectadas_fase2`** (Supabase) para cruzarla con
   `valuation_log` y obtener la lista de a quién avisar de que su valoración
   cambió. Ver la migración `20260812_valuation_log.sql` en predios-mvp.

### Formato

| columna | qué |
|---|---|
| `parcel_ref` | referencia catastral de parcela, 14 caracteres |
| `bienes_superficie` | bienes cuya vivienda gana superficie |
| `bienes_sin_v` | bienes declarados vivienda que hoy no existen como tal |
| `bienes_fantasma` | bienes NO vivienda que hoy generan una unidad de vivienda |
| `m2_recuperados` | m² privativos que la vivienda gana en esa parcela |
| `m2_fantasma` | m² que hoy figuran como vivienda y no lo son |

Los recuentos por parcela permiten priorizar: no es lo mismo una parcela que
gana 17 m² que una que gana 829.

### Criterio, en detalle

Una parcela entra si contiene **al menos un** bien inmueble en alguno de estos
tres estados, comparando el uso DECLARADO del bien (registro 15, posición 428)
con el destino de sus recintos (registro 14, posiciones 71-73):

| estado | condición | bienes |
|---|---|---|
| `superficie` | 428=V y parte de la privativa está en recintos que no son V **ni** A | 21.153 |
| `sin_v` | 428=V y **ningún** recinto tiene destino V | 148 |
| `fantasma` | 428≠V pero hay algún recinto con destino V | 669 |
| | **total** | **21.970** |

**No entran** los bienes cuya única parte no-V son recintos de destino A
(almacén-estacionamiento): siguen siendo unidad propia por decisión tomada, y
la vivienda no cambia de superficie. Son 281.500 bienes, la inmensa mayoría de
los multi-uso — de ahí que el conjunto afectado sea tan pequeño en relación.

Totales: **+1.851.450 m²** de vivienda recuperados y **−228.180 m²** que hoy
figuran como vivienda sin serlo.

### ⚠️ Sobre la cifra de 21.233 que circuló antes

Los informes previos hablaban de **21.233 bienes con superficie corregida**.
La cifra buena es **21.153**, y la diferencia son exactamente **80 bienes** que
en aquella medición se contaban en ese saco y aquí tienen categoría propia:
los que además de tener recintos no-A **no tienen ningún recinto V**, y por
tanto pertenecen a `sin_v` (148 en total, de los cuales 80 tienen parte no-A y
68 solo anexos). No es deriva: es la misma población, mejor clasificada.

Y `21.233` nunca fueron *parcelas*, aunque se citara así alguna vez. Son
bienes inmuebles. Las parcelas son **18.959**, porque una parcela puede
contener varios bienes afectados.

### Alcance

**Solo Madrid capital.** El resto de provincias no está medido, y extrapolar
sería engañoso: la proporción de bienes afectados va del 1,39 % de Madrid al
14,93 % de Alicante. Cuando toque avisar a escala nacional habrá que regenerar
esta lista provincia por provincia con el mismo script.

### Cumplimiento DGC

Verificado: las 18.959 claves son de 14 caracteres y **no aparece ninguna
cadena de 20 en ninguna posición del fichero**. Sin titulares, sin valores
catastrales, sin domicilios, sin superficies por bien individual — solo
agregados por parcela. Cláusulas 5, 6, 7, 8 y 12.

### Regenerarla

```bash
node scripts/genera-afectadas-fase2.mjs
```

Debe dar el mismo sha256 mientras se use el mismo `.CAT`. Si cambia el fichero
de origen, cambia la lista: es un dato derivado, no una decisión.
