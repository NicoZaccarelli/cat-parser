import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";

const envPath = path.join(process.cwd(), ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf-8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!, { auth: { persistSession: false } });

// Réplica del algoritmo buildFullRefcat de la app
const CHAR_VAL: Record<string, number> = {};
'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').forEach((c, i) => { CHAR_VAL[c] = i + 1; });
for (let d = 0; d <= 9; d++) CHAR_VAL[String(d)] = d;
const WEIGHTS = [13, 15, 12, 5, 4, 17, 9, 21, 3, 7, 1];
const OUT_CC1 = 'ABCDEFGHIJKLMNOPQRSTUVW';
const OUT_CC2 = 'DEFGHIJKLMNOPQRSTUVWXYZ';
function computeControlDigit(input: string, outAlpha: string): string {
  const sum = input.split('').reduce((acc, c, i) => acc + (CHAR_VAL[c] ?? 0) * WEIGHTS[i], 0);
  return outAlpha[sum % 23] ?? '?';
}
function buildFullRefcat(pc1: string, pc2: string, car = '0001'): string {
  const cc1 = computeControlDigit(pc2 + car, OUT_CC1);
  const cc2 = computeControlDigit(pc1 + car, OUT_CC2);
  return `${pc1}${pc2}${car}${cc1}${cc2}`;
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

async function callDNPRC(provincia: string, municipio: string, rc: string): Promise<string> {
  const url = `https://ovc.catastro.meh.es/ovcservweb/OVCSWLocalizacionRC/OVCCallejero.asmx/Consulta_DNPRC?Provincia=${encodeURIComponent(provincia)}&Municipio=${encodeURIComponent(municipio)}&RC=${rc}`;
  console.log(`\n>>> URL: ${url}`);
  const res = await fetch(url, {
    headers: { Accept: "application/xml, text/xml;q=0.9", "User-Agent": UA },
    cache: "no-store",
  });
  console.log(`HTTP: ${res.status}`);
  return await res.text();
}

function extract(xml: string, tags: string[]): string {
  for (const tag of tags) {
    const re = new RegExp(`<(?:[\\w]+:)?${tag}[^>]*>([^<]*)</`, 'i');
    const m = xml.match(re);
    if (m) return m[1].trim();
  }
  return '';
}

function summary(xml: string): string {
  const error = extract(xml, ['des', 'desfb', 'cod']);
  const clase = extract(xml, ['cn', 'cuc']);
  const uso = extract(xml, ['lcd', 'luso', 'uso']);
  const sup = extract(xml, ['sfc', 'stl', 'sup']);
  const ant = extract(xml, ['ant', 'anio', 'anno']);
  const consBlocks = (xml.match(/<(?:[\w]+:)?cons\b/gi) ?? []).length;
  const errPresente = /\<(?:[\w]+:)?(err|erro|error|control)\b/i.test(xml);
  const lines = [
    `  XML length     : ${xml.length}`,
    `  ERROR/DES tag  : ${error || '-'}`,
    `  Tag <err>?     : ${errPresente}`,
    `  Clase          : ${clase || '-'}`,
    `  Uso            : ${uso || '-'}`,
    `  Superficie     : ${sup || '-'}`,
    `  Año            : ${ant || '-'}`,
    `  <cons> blocks  : ${consBlocks}`,
  ];
  return lines.join('\n');
}

async function main() {
  console.log("======================================================");
  console.log("TEST 1: Manacor RD MATI 34 (2194104ED3729S)");
  console.log("======================================================");

  const t1a = await callDNPRC("ILLES BALEARS", "MANACOR", "2194104ED3729S");
  console.log("\n--- 1.A: 14 chars ---");
  console.log(summary(t1a));
  console.log("\n... XML completo:");
  console.log(t1a);

  await new Promise(r => setTimeout(r, 1500));

  const t1b = await callDNPRC("ILLES BALEARS", "MANACOR", "2194104ED3729S0001EO");
  console.log("\n--- 1.B: 20 chars REAL (0001EO) ---");
  console.log(summary(t1b));
  console.log("\n... XML completo:");
  console.log(t1b);

  await new Promise(r => setTimeout(r, 1500));

  const t1c = await callDNPRC("ILLES BALEARS", "MANACOR", "2194104ED3729S0001AG");
  console.log("\n--- 1.C: 20 chars SINTÉTICO (buildFullRefcat → 0001AG) ---");
  console.log(summary(t1c));
  console.log("\n... XML completo:");
  console.log(t1c);

  await new Promise(r => setTimeout(r, 2000));

  console.log("\n\n======================================================");
  console.log("TEST 2: Madrid (sample random de Supabase)");
  console.log("======================================================\n");

  const { data: madridSample } = await supabase
    .from("buildings")
    .select("parcel_ref, address, municipality, total_units")
    .eq("province", "Madrid")
    .gte("total_units", 10)
    .lte("total_units", 30)
    .limit(1);

  if (!madridSample || madridSample.length === 0) {
    console.log("No Madrid sample found"); return;
  }
  const m = madridSample[0];
  console.log(`Sample: parcel_ref=${m.parcel_ref}  addr='${m.address}'  units=${m.total_units}`);

  const pc1 = (m.parcel_ref as string).substring(0, 7);
  const pc2 = (m.parcel_ref as string).substring(7, 14);
  const synthetic20 = buildFullRefcat(pc1, pc2);
  console.log(`14-char: ${m.parcel_ref}`);
  console.log(`20-char SINTÉTICO: ${synthetic20}`);

  await new Promise(r => setTimeout(r, 1500));

  const t2a = await callDNPRC("MADRID", "MADRID", m.parcel_ref as string);
  console.log("\n--- 2.A: Madrid 14 chars ---");
  console.log(summary(t2a));
  console.log("\n... XML primeros 3000 chars:");
  console.log(t2a.slice(0, 3000));

  await new Promise(r => setTimeout(r, 1500));

  const t2b = await callDNPRC("MADRID", "MADRID", synthetic20);
  console.log("\n--- 2.B: Madrid 20 chars SINTÉTICO ---");
  console.log(summary(t2b));
  console.log("\n... XML primeros 3000 chars:");
  console.log(t2b.slice(0, 3000));
}

main().catch(e => { console.error(e); process.exit(1); });
