// Mapping código AFA (4 dígitos) → nombre oficial del municipio.
//
// Los GML INSPIRE de Álava (BU y CP) NO contienen el nombre del municipio:
// `bu-base:name` viene con `nilReason=Unpopulated` en todos los buildings.
// Solo aparece el header "Catastro de Álava". Por eso este mapping se
// mantiene manualmente aquí.
//
// Patrón: cod4 AFA = "01" + últimos 2 dígitos del código INE de 5 dígitos.
//   Ej.: 0159 AFA → INE 01059 → Vitoria-Gasteiz.
//        0106 AFA → INE 01006 → Armiñón.
//
// Formato del nombre:
//   - Castellano por defecto (matchea directo con las claves de
//     market-prices-idealista.json cuando existen: vitoria-gasteiz, llodio).
//   - Municipios con precio Idealista van SIN forma bilingüe "/" porque
//     `normalizeKey` en valuation.ts elimina la "/" (no la convierte en "--"),
//     lo que rompería el matching (ej. "Llodio/Laudio" → "llodiolaudio").
//   - Municipios sin precio Idealista pueden ir con nombre bilingüe (el
//     nombre no afecta al matching de precio, solo se ve en la ficha).

export const ALAVA_MUNICIPIOS = new Map<string, string>([
  ["0101", "Alegría-Dulantzi"],
  ["0102", "Amurrio"],
  ["0103", "Añana"],
  ["0104", "Aramaio"],
  ["0106", "Armiñón"],
  ["0108", "Arraia-Maeztu"],
  ["0109", "Arratzua-Ubarrundia"],
  ["0110", "Artziniega"],
  ["0111", "Asparrena"],
  ["0113", "Ayala/Aiara"],
  ["0114", "Baños de Ebro"],
  ["0116", "Barrundia"],
  ["0117", "Berantevilla"],
  ["0118", "Bernedo"],
  ["0119", "Campezo/Kanpezu"],
  ["0120", "Zigoitia"],
  ["0121", "Kripan"],
  ["0122", "Kuartango"],
  ["0123", "Elburgo/Burgelu"],
  ["0126", "Elciego"],
  ["0127", "Elvillar/Bilar"],
  ["0128", "Ribera Alta"],
  ["0130", "Valle de Arana"],
  ["0131", "Iruña de Oca"],
  ["0132", "Iruraiz-Gauna"],
  ["0133", "Labastida"],
  ["0134", "Lagrán"],
  ["0135", "Laguardia"],
  ["0136", "Lanciego/Lantziego"],
  ["0137", "Lantarón"],
  ["0139", "Lapuebla de Labarca"],
  ["0141", "Leza"],
  ["0142", "Llodio"], // sin /Laudio → matchea zona Idealista "llodio"
  ["0143", "Moreda de Álava"],
  ["0144", "Navaridas"],
  ["0146", "Okondo"],
  ["0147", "Oyón-Oion"],
  ["0149", "Peñacerrada-Urizaharra"],
  ["0151", "Ribera Baja"],
  ["0152", "Salvatierra"],
  ["0153", "Samaniego"],
  ["0154", "San Millán/Donemiliaga"],
  ["0155", "Urkabustaiz"],
  ["0156", "Valdegovía"],
  ["0157", "Legutio"],
  ["0158", "Villabuena de Álava"],
  ["0159", "Vitoria-Gasteiz"], // matchea zona Idealista "vitoria-gasteiz"
  ["0160", "Yécora"],
  ["0161", "Zalduondo"],
  ["0162", "Zambrana"],
  ["0163", "Zuia"],
  ["0165", "Lezama"],
]);
