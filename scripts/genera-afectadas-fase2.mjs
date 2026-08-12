// Parcelas de Madrid capital cuya superficie de vivienda cambia con la Fase 2.
//
// Una parcela entra si contiene AL MENOS UN bien inmueble en alguno de estos
// tres estados, evaluados sobre el CAT con el uso declarado del registro 15
// (posición 428) frente al destino de los recintos del registro 14:
//
//   superficie  428=V y parte de la privativa está en recintos que NO son V
//               ni A. Hoy la vivienda se queda solo con los recintos V; con
//               la Fase 2 absorbe también los demás salvo los anexos.
//   sin_v       428=V y NINGÚN recinto tiene destino V. Hoy esa vivienda no
//               existe como tal en la base.
//   fantasma    428≠V pero hay algún recinto con destino V. Hoy genera una
//               unidad de vivienda que no debería existir.
//
// NO entran los bienes cuya única parte no-V son recintos de destino A
// (almacén-estacionamiento): esos siguen siendo unidad propia por decisión
// tomada, y su vivienda no cambia de superficie.
import { createReadStream, createWriteStream } from "node:fs";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";

// Ruta del CAT de Madrid capital y destino del CSV. Ambos parametrizables por
// argumento para poder regenerar la lista de otra provincia sin tocar código.
const CAT = process.argv[2] ?? "D:/canScan/cat/28900U_23012026.CAT";
const OUT = process.argv[3] ?? "goldens/afectadas-fase2-madrid-2026-01-23.csv";
const S = (l, a, b) => l.substring(a - 1, b);

const out = createWriteStream(OUT, { encoding: "utf8" });
const hash = createHash("sha256");
const w = (linea) => { hash.update(linea); out.write(linea); };
w("parcel_ref,bienes_superficie,bienes_sin_v,bienes_fantasma,m2_recuperados,m2_fantasma\n");

const st = { parcelas: 0, filas: 0, bSup: 0, bSinV: 0, bFant: 0, m2Rec: 0, m2Fant: 0 };
let parcela = null, t14 = [], t15 = new Map();

function cerrar() {
  if (!parcela) { t14 = []; t15 = new Map(); return; }
  st.parcelas++;
  const porBien = new Map();
  for (const r of t14) {
    if (!r.bien || r.sup <= 0) continue;
    let m = porBien.get(r.bien);
    if (!m) { m = new Map(); porBien.set(r.bien, m); }
    m.set(r.uso, (m.get(r.uso) ?? 0) + r.sup);
  }
  let sup = 0, sinV = 0, fant = 0, m2r = 0, m2f = 0;
  for (const [bien, usos] of porBien) {
    const u = (t15.get(bien) ?? "").trim().toUpperCase();
    const total = [...usos.values()].reduce((a, b) => a + b, 0);
    const v = usos.get("V") ?? 0;
    const a = usos.get("A") ?? 0;
    if (u === "V") {
      if (v === total) continue;              // todo vivienda: sin cambio
      if (v === 0) { sinV++; m2r += total - a; continue; }
      if (v + a === total) continue;          // solo anexos A: sin cambio
      sup++; m2r += total - v - a;
    } else if (v > 0) {
      fant++; m2f += v;
    }
  }
  if (sup || sinV || fant) {
    st.filas++; st.bSup += sup; st.bSinV += sinV; st.bFant += fant;
    st.m2Rec += m2r; st.m2Fant += m2f;
    w(`${parcela},${sup},${sinV},${fant},${m2r},${m2f}\n`);
  }
  t14 = []; t15 = new Map();
}

const rl = createInterface({ input: createReadStream(CAT, { encoding: "latin1" }), crlfDelay: Infinity });
for await (const line of rl) {
  const t = line.substring(0, 2);
  if (t === "11") { cerrar(); parcela = S(line, 31, 44); continue; }
  if (t === "14") {
    const p = S(line, 31, 44); if (p !== parcela) { cerrar(); parcela = p; }
    t14.push({ bien: S(line, 51, 54).trim(),
      uso: (S(line, 71, 73).trim().charAt(0) || "?").toUpperCase(),
      sup: parseInt(S(line, 84, 90), 10) || 0 });
  } else if (t === "15") {
    const p = S(line, 31, 44); if (p !== parcela) { cerrar(); parcela = p; }
    t15.set(S(line, 45, 48).trim(), S(line, 428, 428));
  }
}
cerrar();
out.end();

console.log(`parcelas recorridas      : ${st.parcelas.toLocaleString("es-ES")}`);
console.log(`parcelas AFECTADAS       : ${st.filas.toLocaleString("es-ES")}`);
console.log(`  bienes con superficie  : ${st.bSup.toLocaleString("es-ES")}`);
console.log(`  bienes sin recinto V   : ${st.bSinV.toLocaleString("es-ES")}`);
console.log(`  bienes fantasma        : ${st.bFant.toLocaleString("es-ES")}`);
console.log(`  m² de vivienda a sumar : ${st.m2Rec.toLocaleString("es-ES")}`);
console.log(`  m² fantasma a retirar  : ${st.m2Fant.toLocaleString("es-ES")}`);
console.log(`\nsha256 del CSV: ${hash.digest("hex")}`);
