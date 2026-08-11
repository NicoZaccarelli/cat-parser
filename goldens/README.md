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
**21.233 parcelas** cuyos bienes tienen recintos de un uso que no es
almacén-estacionamiento. **Cualquier movimiento en una parcela de vivienda
pura es una regresión**, no una mejora.
