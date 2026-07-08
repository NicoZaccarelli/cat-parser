// Parser INSPIRE AD (Address) de Bizkaia.
// Formato per Address:
//   localId = "48.MMM.CCCCC.PPP"   (código municipio, código calle, número portal)
//   gn:text = "48 MMM TIPO\NOMBRE(CCCCC) PPP"
//     TIPO ∈ {CL=Calle, BO=Barrio, AV=Avenida, PZ=Plaza, PS=Paseo, ...}
//     NOMBRE es el texto entre "\" y "("
//
// Devuelve un mapa: localId → { tipoVia, nombreVia, numeroPortal }
//
// El fichero AD de Bizkaia por municipio son de <10 MB; carga entera en memoria.

import * as fs from "node:fs";
import * as unzipper from "unzipper";
import { SaxesParser } from "saxes";

export interface CallejeroEntry {
  localId: string; // "48.MMM.CCCCC.PPP"
  codigoCal: string; // "CCCCC" (5 dígitos)
  numeroPortal: string; // "PPP" (3 dígitos)
  tipoVia: string; // "BO", "CL", "AV"...
  nombreVia: string; // "MURUETA", "SAN ANDRÉS"...
}

const TIPO_LABEL: Record<string, string> = {
  CL: "Calle",
  BO: "Barrio",
  AV: "Avenida",
  PZ: "Plaza",
  PS: "Paseo",
  TR: "Travesía",
  RD: "Ronda",
  CT: "Carretera",
  CJ: "Callejón",
  GL: "Glorieta",
  UR: "Urbanización",
  BJ: "Bajada",
  SB: "Subida",
  CS: "Caserío",
  LG: "Lugar",
};

export function labelFromTipo(tipo: string): string {
  const t = tipo.trim().toUpperCase();
  return TIPO_LABEL[t] || t;
}

/**
 * Formatea una dirección: "Barrio Murueta, 3" / "Calle San Andrés, 10".
 */
export function formatDireccion(entry: CallejeroEntry): string {
  const num = String(parseInt(entry.numeroPortal, 10) || 0);
  return `${labelFromTipo(entry.tipoVia)} ${titleCase(entry.nombreVia)}, ${num}`;
}

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/(^|\s|-|\/|'|\.)(\p{L})/gu, (_m, sep, ch) => `${sep}${ch.toUpperCase()}`);
}

// Parseo del gn:text "48 MMM TIPO\NOMBRE(CCCCC) PPP"
export function parseGnText(text: string): { tipoVia: string; nombreVia: string } | null {
  // Buscar "TIPO\NOMBRE(CCCCC)"
  const m = text.match(/\s([A-Z]{2})\\(.+?)\((\d{5})\)/);
  if (!m) return null;
  return { tipoVia: m[1], nombreVia: m[2].trim() };
}

/**
 * Carga el callejero AD desde el zip del municipio.
 * Devuelve mapa por localId. Si no existe zip (ej. Usansolo 916), devuelve mapa vacío.
 */
export async function loadCallejero(
  callejeroZipPath: string,
): Promise<Map<string, CallejeroEntry>> {
  const result = new Map<string, CallejeroEntry>();

  if (!fs.existsSync(callejeroZipPath)) {
    return result; // caller decide si logea el missing (ej. 916)
  }

  const zip = await unzipper.Open.file(callejeroZipPath);
  const entry = zip.files.find((f) => f.path === "ES.BFA.AD.gml");
  if (!entry) {
    return result;
  }
  const stream = entry.stream();
  const parser = new SaxesParser({ xmlns: false });

  let inAddress = false;
  let currentLocalId = "";
  let firstGnText = "";
  let capturingLocalId = false;
  let capturingGnText = false;
  let localIdBuf = "";
  let gnTextBuf = "";
  let hasGnText = false;

  parser.on("opentag", (tag) => {
    const local = stripNs(tag.name);
    if (local === "Address") {
      inAddress = true;
      currentLocalId = "";
      firstGnText = "";
      hasGnText = false;
    } else if (inAddress && local === "localId") {
      capturingLocalId = true;
      localIdBuf = "";
    } else if (inAddress && local === "text" && !hasGnText) {
      // gn:text — solo capturamos el PRIMERO por Address
      capturingGnText = true;
      gnTextBuf = "";
    }
  });

  parser.on("text", (t) => {
    if (capturingLocalId) localIdBuf += t;
    else if (capturingGnText) gnTextBuf += t;
  });

  parser.on("closetag", (tag) => {
    const local = stripNs(tag.name);
    if (capturingLocalId && local === "localId") {
      currentLocalId = localIdBuf.trim();
      capturingLocalId = false;
    } else if (capturingGnText && local === "text") {
      if (!hasGnText) {
        firstGnText = gnTextBuf.trim();
        hasGnText = true;
      }
      capturingGnText = false;
    } else if (local === "Address" && inAddress) {
      const parts = currentLocalId.split(".");
      if (parts.length === 4 && firstGnText) {
        const parsed = parseGnText(firstGnText);
        if (parsed) {
          result.set(currentLocalId, {
            localId: currentLocalId,
            codigoCal: parts[2],
            numeroPortal: parts[3],
            tipoVia: parsed.tipoVia,
            nombreVia: parsed.nombreVia,
          });
        }
      }
      inAddress = false;
    }
  });

  parser.on("error", (err) => {
    throw err;
  });

  await new Promise<void>((resolve, reject) => {
    stream.on("data", (chunk: Buffer) => {
      try {
        parser.write(chunk.toString("utf8"));
      } catch (err) {
        reject(err);
      }
    });
    stream.on("end", () => {
      try {
        parser.close();
        resolve();
      } catch (err) {
        reject(err);
      }
    });
    stream.on("error", reject);
  });

  return result;
}

function stripNs(qname: string): string {
  const i = qname.indexOf(":");
  return i >= 0 ? qname.slice(i + 1) : qname;
}

/**
 * Construye el localId a partir de Codigo_Cal, Numero_Por y Duplicado_ del Edificio.
 * Codigo_Cal en Bizkaia viene como número sin padding ("26"), pero el localId
 * usa 5 dígitos ("00026"). Numero_Por ya viene con 3 dígitos ("003").
 * Duplicado_ (opcional) es un sufijo alfabético ("A", "B") que aparece cuando
 * el mismo Numero_Por tiene múltiples portales físicos (ej. 060A y 060B).
 * Verificado en Abadiño: 51 casos con Duplicado_ ∈ {A, B}.
 */
export function buildLocalId(
  mun: string,
  codigoCal: string,
  numeroPor: string,
  duplicado?: string,
): string {
  const munPadded = mun.padStart(3, "0");
  const calPadded = codigoCal.trim().padStart(5, "0");
  const porPadded = numeroPor.trim().padStart(3, "0");
  const dup = (duplicado || "").trim();
  return `48.${munPadded}.${calPadded}.${porPadded}${dup}`;
}
