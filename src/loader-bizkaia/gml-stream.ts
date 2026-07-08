// Streaming SAX parser genérico para los GMLs FME de Bizkaia.
// Cada capa es un array de <fme:featureMember><fme:_{mun}_{Capa}>...</...>.
// Cada feature tiene atributos como <fme:AttrName>valor</fme:AttrName> y
// (opcional) una geometría bajo <gml:posList>.
//
// El streaming es OBLIGATORIO: Bilbao pesa 63 MB comprimido (~600 MB descomprimido).

import { SaxesParser } from "saxes";
import * as fs from "node:fs";
import * as unzipper from "unzipper";

export interface GmlFeature {
  /** Atributos escalares (todos como string; interpretar en el llamador). */
  attrs: Record<string, string>;
  /**
   * posList del ring EXTERIOR del primer PolygonPatch, si existe.
   * (Los GML de Bizkaia son polígonos simples de 1 ring exterior por feature.)
   */
  posList?: string;
}

/**
 * Stream de features de un GML dentro de un zip.
 * Emite cada feature completa vía callback y llama a `onEnd` al terminar.
 */
export async function streamGmlFromZip(
  zipPath: string,
  gmlFileNameInsideZip: string,
  featureTagLocalName: string, // ej. "_001_Edificio" (sin namespace)
  onFeature: (f: GmlFeature) => void,
): Promise<void> {
  const zip = await unzipper.Open.file(zipPath);
  const entry = zip.files.find((f) => f.path === gmlFileNameInsideZip);
  if (!entry) {
    throw new Error(`GML no encontrado en zip: ${gmlFileNameInsideZip}`);
  }

  const readStream = entry.stream();
  const parser = new SaxesParser({ xmlns: false });

  let inFeature = false;
  let currentAttrs: Record<string, string> = {};
  let currentPosList: string | undefined;

  let currentText = "";
  let currentTag: string | null = null;

  // Contexto para detectar posList del exterior ring.
  let insideExterior = false;
  let capturedPosList = false; // solo el primero

  parser.on("opentag", (tag) => {
    const local = stripNs(tag.name);
    if (!inFeature) {
      if (local === featureTagLocalName) {
        inFeature = true;
        currentAttrs = {};
        currentPosList = undefined;
        insideExterior = false;
        capturedPosList = false;
      }
      return;
    }
    // Estamos en una feature.
    if (local === "exterior") {
      insideExterior = true;
    }
    currentTag = local;
    currentText = "";
  });

  parser.on("text", (t) => {
    if (inFeature) currentText += t;
  });

  parser.on("cdata", (c) => {
    if (inFeature) currentText += c;
  });

  parser.on("closetag", (tag) => {
    const local = stripNs(tag.name);
    if (!inFeature) return;

    if (local === featureTagLocalName) {
      onFeature({ attrs: currentAttrs, posList: currentPosList });
      inFeature = false;
      currentAttrs = {};
      currentPosList = undefined;
      currentTag = null;
      currentText = "";
      insideExterior = false;
      capturedPosList = false;
      return;
    }

    if (local === "exterior") {
      insideExterior = false;
    }

    if (local === "posList" && insideExterior && !capturedPosList) {
      currentPosList = currentText.trim();
      capturedPosList = true;
    } else if (
      currentTag === local &&
      !local.startsWith("gml") &&
      local !== "featureMember" &&
      local !== "FeatureCollection"
    ) {
      // Atributo fme:* — capturar valor.
      // Solo si el nombre NO es un contenedor GML (Surface, patches, ring, etc.).
      // La lista blanca simple es: cualquier tag con contenido "leaf" que no sea GML.
      if (!isGmlContainer(local)) {
        currentAttrs[local] = currentText.trim();
      }
    }
    currentTag = null;
    currentText = "";
  });

  parser.on("error", (err) => {
    throw err;
  });

  return new Promise<void>((resolve, reject) => {
    readStream.on("data", (chunk: Buffer) => {
      try {
        parser.write(chunk.toString("utf8"));
      } catch (err) {
        reject(err);
      }
    });
    readStream.on("end", () => {
      try {
        parser.close();
        resolve();
      } catch (err) {
        reject(err);
      }
    });
    readStream.on("error", reject);
  });
}

function stripNs(qname: string): string {
  const i = qname.indexOf(":");
  return i >= 0 ? qname.slice(i + 1) : qname;
}

const GML_CONTAINERS = new Set([
  "surfaceProperty",
  "Surface",
  "patches",
  "PolygonPatch",
  "exterior",
  "interior",
  "LinearRing",
  "posList",
  "boundedBy",
  "Envelope",
  "lowerCorner",
  "upperCorner",
]);

function isGmlContainer(name: string): boolean {
  return GML_CONTAINERS.has(name);
}
