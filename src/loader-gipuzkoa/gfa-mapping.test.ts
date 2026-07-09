// Test unitario: contrato entre gfa-mapping y foralAggregates.ts (predios-mvp).
//
// Ejecutar: npx tsx src/loader-gipuzkoa/gfa-mapping.test.ts
//
// foralAggregates.ts en predios-mvp mapea EXACTAMENTE "Vivienda" → "Residencial".
// Si el loader emite "vivienda" (minúscula) o "V" el string exact match falla
// y la ficha no marca correctamente el uso. Este test garantiza el contrato.

import { mapGfaDestino, GFA_KNOWN_MAPPING, GFA_UNKNOWN_CODES } from "./gfa-mapping.js";

interface TestCase {
  name: string;
  input: string;
  expectedCategory: string;
  expectedKnown: boolean;
}

const cases: TestCase[] = [
  { name: "V → Vivienda EXACTO (contrato con foralAggregates)", input: "V", expectedCategory: "Vivienda", expectedKnown: true },
  { name: "P → Aparcamiento", input: "P", expectedCategory: "Aparcamiento", expectedKnown: true },
  { name: "G → Garaje", input: "G", expectedCategory: "Garaje", expectedKnown: true },
  { name: "T → Trastero", input: "T", expectedCategory: "Trastero", expectedKnown: true },
  { name: "C → Comercial", input: "C", expectedCategory: "Comercial", expectedKnown: true },
  { name: "O → Oficinas", input: "O", expectedCategory: "Oficinas", expectedKnown: true },
  { name: "Z (UNKNOWN_CODES) → Otros, wasKnown=true", input: "Z", expectedCategory: "Otros", expectedKnown: true },
  { name: "X (UNKNOWN_CODES) → Otros", input: "X", expectedCategory: "Otros", expectedKnown: true },
  { name: "Código nuevo no visto → Desconocido, wasKnown=false", input: "Ñ", expectedCategory: "Desconocido", expectedKnown: false },
  { name: "Código vacío → Otros (fila sin destino)", input: "", expectedCategory: "Otros", expectedKnown: true },
  { name: "Case insensitive: 'v' → Vivienda", input: "v", expectedCategory: "Vivienda", expectedKnown: true },
  { name: "Trim: '  V  ' → Vivienda", input: "  V  ", expectedCategory: "Vivienda", expectedKnown: true },
];

let ok = 0;
let fail = 0;
for (const tc of cases) {
  const r = mapGfaDestino(tc.input);
  const passed = r.category === tc.expectedCategory && r.wasKnown === tc.expectedKnown;
  console.log(
    `${passed ? "✓" : "✗"} ${tc.name.padEnd(60)} input="${tc.input}" → ${JSON.stringify(r)}`,
  );
  if (!passed) {
    console.log(`    expected: category="${tc.expectedCategory}", wasKnown=${tc.expectedKnown}`);
    fail++;
  } else ok++;
}

// Contrato adicional: KNOWN_MAPPING debe emitir "Vivienda" EXACTO para 'V'
// (no "vivienda", no "Residencial"). foralAggregates.ts hace el alias hacia
// "Residencial" en runtime.
console.log(
  `\nKNOWN_MAPPING["V"] === "Vivienda": ${GFA_KNOWN_MAPPING.V === "Vivienda" ? "✓" : "✗"}`,
);
console.log(
  `GFA_UNKNOWN_CODES.has("Z"): ${GFA_UNKNOWN_CODES.has("Z") ? "✓" : "✗"}`,
);

console.log(`\n${ok}/${ok + fail} tests passed`);
if (fail > 0) process.exit(1);
