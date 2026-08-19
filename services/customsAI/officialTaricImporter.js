"use strict";

const fs = require("node:fs");
const path = require("node:path");
const ExcelJS = require("exceljs");
const { AidaNomenclatureClient } = require("./aidaNomenclatureClient");
const { aliasesForRecord, inferMaterials } = require("./searchLexicon");
const { normalizeCode, normalizeText, sanitizeText, uniqueStrings } = require("./textUtils");

const CIRCABC_ROOT_ID = "64db9d0f-e7c9-4084-afe9-f47e70e53c10";
const CIRCABC_API = "https://circabc.europa.eu/service/api/node/workspace/SpacesStore";
const OFFICIAL_TARIC_PAGE = "https://taxation-customs.ec.europa.eu/customs/common-customs-tariff-cct/tariff-classification-goods/eu-customs-tariff-taric_en?prefLang=it";
const AIDA_TARIC_PAGE = "https://aidaonline7.adm.gov.it/nsitaricinternet/TaricServlet";

class OfficialTaricImporter {
  constructor(options = {}) {
    this.fetch = options.fetch || global.fetch;
    this.fs = options.fs || fs;
    this.now = options.now || (() => new Date());
    this.userAgent = options.userAgent || "DoganaTools-TARIC-Updater/1.0";
    if (typeof this.fetch !== "function") throw new Error("Fetch non disponibile: serve Node.js 20 o successivo.");
  }

  async update(options = {}) {
    const rootDir = path.resolve(options.rootDir || path.resolve(__dirname, "../.."));
    const cacheDir = path.resolve(options.cacheDir || path.join(rootDir, "cache", "taric-official"));
    const targetPath = path.resolve(options.targetPath || path.join(rootDir, "data", "customs", "processed", "customs-dataset.json"));
    this.fs.mkdirSync(cacheDir, { recursive: true });

    const snapshot = await this.resolveSnapshot(options);
    const currentPrefix = `${snapshot.current.year}-${snapshot.current.month}`;
    const italianPrefix = `${snapshot.italian.year}-${snapshot.italian.month}`;
    const files = {
      nomenclatureEn: path.join(cacheDir, `${currentPrefix}-nomenclature-en.xlsx`),
      declarableCodes: path.join(cacheDir, `${currentPrefix}-declarable-codes.xlsx`),
      nomenclatureIt: path.join(cacheDir, `${italianPrefix}-nomenclature-it.xlsx`)
    };

    const refreshFiles = options.reuseCache !== true;
    await this.download(snapshot.current.files.get("Nomenclature EN.xlsx"), files.nomenclatureEn, refreshFiles || options.force);
    await this.download(snapshot.current.files.get("Declarable codes.xlsx"), files.declarableCodes, refreshFiles || options.force);
    await this.download(snapshot.italian.files.get("Nomenclature IT.xlsx"), files.nomenclatureIt, refreshFiles || options.force);

    const [englishRows, italianRows, declarableRows] = await Promise.all([
      readNomenclatureWorkbook(files.nomenclatureEn),
      readNomenclatureWorkbook(files.nomenclatureIt),
      readDeclarableWorkbook(files.declarableCodes)
    ]);
    let supplementedItalianRows = italianRows;
    let aidaSupplementedRows = 0;
    let aidaDataDate = null;
    let aidaWarning = null;
    if (options.aida !== false) {
      const existingItalianKeys = new Set(italianRows.map(row => row.key));
      const missingKeys = englishRows.filter(row => !existingItalianKeys.has(row.key)).map(row => row.key);
      if (missingKeys.length) {
        try {
          const aida = new AidaNomenclatureClient({ fetch: this.fetch, userAgent: this.userAgent });
          const descriptions = await aida.fetchItalianDescriptions(missingKeys);
          const englishByKey = new Map(englishRows.map(row => [row.key, row]));
          const additions = [];
          for (const [key, description] of descriptions) {
            const english = englishByKey.get(key);
            if (!english) continue;
            additions.push({ ...english, language: "IT", description, descriptionSource: "AIDA" });
          }
          supplementedItalianRows = [...italianRows, ...additions];
          aidaSupplementedRows = additions.length;
          aidaDataDate = aida.dataDate;
        } catch (error) {
          aidaWarning = sanitizeText(error?.message || error, 300);
        }
      }
    }
    const retrievedAt = this.now().toISOString();
    const dataset = buildOfficialDataset({
      englishRows,
      italianRows: supplementedItalianRows,
      declarableRows,
      currentSnapshot: snapshot.current,
      italianSnapshot: snapshot.italian,
      aidaSupplementedRows,
      aidaDataDate,
      aidaWarning,
      retrievedAt
    });
    validateOfficialDataset(dataset, declarableRows);

    const report = {
      success: true,
      dryRun: options.dryRun === true,
      targetPath,
      currentSnapshot: `${currentPrefix}`,
      italianSnapshot: `${italianPrefix}`,
      declarableCodes: dataset.tariff_codes.length,
      nomenclatureRows: dataset.tariff_descriptions.length,
      italianRows: dataset.coverage.italian_rows,
      fallbackEnglishRows: dataset.coverage.english_fallback_rows,
      aidaSupplementedRows,
      aidaDataDate,
      aidaWarning,
      retrievedAt,
      backupPath: null
    };
    if (options.dryRun) return { dataset, report };

    this.fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    const tempPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
    this.fs.writeFileSync(tempPath, `${JSON.stringify(dataset)}\n`, "utf8");
    let backupPath = null;
    try {
      if (this.fs.existsSync(targetPath)) {
        const backupDir = path.join(path.dirname(targetPath), "backups");
        this.fs.mkdirSync(backupDir, { recursive: true });
        backupPath = path.join(backupDir, `customs-dataset-${safeTimestamp()}.json`);
        this.fs.renameSync(targetPath, backupPath);
      }
      this.fs.renameSync(tempPath, targetPath);
    } catch (error) {
      try {
        if (backupPath && !this.fs.existsSync(targetPath) && this.fs.existsSync(backupPath)) {
          this.fs.renameSync(backupPath, targetPath);
        }
      } catch {}
      try { if (this.fs.existsSync(tempPath)) this.fs.unlinkSync(tempPath); } catch {}
      throw error;
    }
    report.backupPath = backupPath;
    return { dataset, report };
  }

  async resolveSnapshot(options = {}) {
    const years = (await this.listChildren(CIRCABC_ROOT_ID))
      .filter(item => /^\d{4}$/.test(item.title) && !item.mimeType)
      .sort((a, b) => b.title.localeCompare(a.title));
    if (!years.length) throw new Error("Nessuna annualità TARIC trovata nell'archivio ufficiale CIRCABC.");

    const months = [];
    for (const year of years.slice(0, 2)) {
      const children = await this.listChildren(year.nodeId);
      for (const month of children.filter(item => /^\d{2}\s*-/.test(item.title) && !item.mimeType)) {
        const number = month.title.slice(0, 2);
        if (options.year && String(options.year) !== year.title) continue;
        if (options.month && String(options.month).padStart(2, "0") !== number) continue;
        months.push({ year: year.title, month: number, nodeId: month.nodeId, title: month.title });
      }
    }
    months.sort((a, b) => `${b.year}${b.month}`.localeCompare(`${a.year}${a.month}`));
    if (!months.length) throw new Error("Nessun mese TARIC compatibile con i parametri richiesti.");

    let current = null;
    let italian = null;
    for (const month of months) {
      const entries = await this.listChildren(month.nodeId);
      const files = new Map(entries.filter(item => item.mimeType).map(item => [canonicalFileName(item.title), item]));
      const enriched = { ...month, files };
      if (!current && files.has("Nomenclature EN.xlsx") && files.has("Declarable codes.xlsx")) current = enriched;
      if (!italian && files.has("Nomenclature IT.xlsx")) italian = enriched;
      if (current && italian && `${italian.year}${italian.month}` <= `${current.year}${current.month}`) break;
    }
    if (!current) throw new Error("L'archivio CIRCABC non contiene una nomenclatura EN e i codici dichiarabili completi.");
    if (!italian) throw new Error("L'archivio CIRCABC non contiene una nomenclatura italiana utilizzabile.");
    return { current, italian };
  }

  async listChildren(nodeId) {
    const response = await this.fetch(`${CIRCABC_API}/${nodeId}/children`, {
      headers: this.headers()
    });
    if (!response.ok) throw new Error(`CIRCABC non disponibile (${response.status}) durante la lettura di ${nodeId}.`);
    return parseAtomChildren(await response.text());
  }

  async download(file, targetPath, force = false) {
    if (!file?.nodeId) throw new Error("File TARIC ufficiale non trovato nell'archivio CIRCABC.");
    if (!force && this.fs.existsSync(targetPath) && this.fs.statSync(targetPath).size > 0) return targetPath;
    const response = await this.fetch(`${CIRCABC_API}/${file.nodeId}/content`, { headers: this.headers() });
    if (!response.ok) throw new Error(`Download TARIC fallito per ${file.title} (${response.status}).`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length < 1024 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
      throw new Error(`Il file ${file.title} non è un XLSX valido.`);
    }
    const tempPath = `${targetPath}.tmp-${process.pid}`;
    this.fs.writeFileSync(tempPath, bytes);
    this.fs.renameSync(tempPath, targetPath);
    return targetPath;
  }

  headers() {
    return {
      Authorization: `Basic ${Buffer.from("guest:").toString("base64")}`,
      "User-Agent": this.userAgent
    };
  }
}

async function readNomenclatureWorkbook(filePath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error(`Foglio mancante in ${filePath}.`);
  const rows = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const key = sanitizeText(cellText(row.getCell(1).value), 40);
    if (!key) return;
    rows.push({
      key,
      code: normalizeCode(key),
      productLineSuffix: key.replace(/^\d{10}\s*/, ""),
      startDate: toIsoDate(cellText(row.getCell(2).value)),
      endDate: toIsoDate(cellText(row.getCell(3).value)) || null,
      language: sanitizeText(cellText(row.getCell(4).value), 4),
      hierarchyPosition: Number(row.getCell(5).value) || 10,
      indent: sanitizeText(cellText(row.getCell(6).value), 30),
      description: cleanDescription(cellText(row.getCell(7).value)),
      descriptionStartDate: toIsoDate(cellText(row.getCell(8).value))
    });
  });
  return rows;
}

async function readDeclarableWorkbook(filePath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error(`Foglio mancante in ${filePath}.`);
  const rows = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const key = sanitizeText(cellText(row.getCell(1).value), 40);
    if (!key) return;
    rows.push({
      key,
      code: normalizeCode(key),
      startDate: toIsoDate(cellText(row.getCell(2).value)),
      declarableStartDate: toIsoDate(cellText(row.getCell(3).value)),
      isLeaf: String(cellText(row.getCell(4).value)).trim() === "1",
      endDate: toIsoDate(cellText(row.getCell(5).value)) || null
    });
  });
  return rows;
}

function buildOfficialDataset(input) {
  const italianByKey = new Map(input.italianRows.map(row => [row.key, row]));
  const declarableByKey = new Map(input.declarableRows.map(row => [row.key, row]));
  const leafKeys = new Set(input.declarableRows.filter(row => row.isLeaf).map(row => row.key));
  const currentVersion = `${input.currentSnapshot.year}-${input.currentSnapshot.month}`;
  const italianVersion = `${input.italianSnapshot.year}-${input.italianSnapshot.month}`;
  const source = "EU TARIC — DG TAXUD";
  const sourceId = "eu-taric-circabc";
  const sourceMetadata = {
    source,
    source_version: currentVersion,
    retrieved_at: input.retrievedAt
  };
  const combinedRows = input.englishRows.map(english => {
    const italian = italianByKey.get(english.key) || null;
    const selected = italian || english;
    return {
      ...english,
      description: selected.description,
      descriptionIt: italian?.description || null,
      descriptionEn: english.description,
      selectedLanguage: italian ? "IT" : "EN",
      isLeaf: leafKeys.has(english.key),
      declarable: declarableByKey.get(english.key) || null
    };
  });
  const pathByKey = buildDescriptionPaths(combinedRows);
  const englishPathByKey = buildDescriptionPaths(input.englishRows.map(row => ({ ...row, selectedLanguage: "EN" })));
  const records = [];
  const seenCodes = new Set();
  for (const row of combinedRows) {
    if (!row.isLeaf || seenCodes.has(row.code)) continue;
    seenCodes.add(row.code);
    const pathItems = pathByKey.get(row.key) || [];
    const pathTerms = uniqueStrings(pathItems.map(item => item.description), 500);
    const englishTerms = uniqueStrings((englishPathByKey.get(row.key) || []).map(item => item.description), 500);
    const description = pathTerms.join(" › ");
    const aliases = aliasesForRecord(row.code);
    const hierarchy = hierarchyForRecord(row.code, pathItems);
    records.push({
      code: row.code,
      level: "TARIC",
      description,
      leaf_description: row.description,
      description_en: englishTerms.join(" › "),
      description_language: pathItems.some(item => item.selectedLanguage === "EN") ? "IT+EN" : "IT",
      product_line_id: row.key,
      product_types: aliases.productTypes,
      keywords: aliases.keywords,
      synonyms: aliases.synonyms,
      materials: inferMaterials(`${description} ${aliases.productTypes.join(" ")}`),
      functions: inferFunctions(description),
      category_terms: uniqueStrings(pathItems
        .filter(item => item.hierarchyPosition <= 6)
        .map(item => item.description), 500),
      _hierarchy: hierarchy,
      required_attributes: inferRequiredAttributes(description),
      excluded_when: [],
      default_assumptions: [],
      result_notes: [],
      source_id: sourceId,
      valid_from: row.declarable?.declarableStartDate || row.startDate || `${input.currentSnapshot.year}-01-01`,
      valid_to: row.declarable?.endDate || row.endDate || null,
      ...sourceMetadata
    });
  }

  const hierarchy = buildHierarchyTable(records, sourceMetadata);
  for (const record of records) delete record._hierarchy;
  const italianCount = combinedRows.filter(row => row.descriptionIt).length;
  return {
    schema_version: 2,
    dataset_status: "official",
    notice: "Nomenclatura TARIC ufficiale. La classificazione automatica resta un supporto operativo e non sostituisce una ITV/BTI o la verifica dell'autorità doganale.",
    coverage: {
      current_snapshot: currentVersion,
      italian_snapshot: italianVersion,
      declarable_codes: records.length,
      nomenclature_rows: combinedRows.length,
      italian_rows: italianCount,
      english_fallback_rows: combinedRows.length - italianCount,
      aida_supplemented_rows: Number(input.aidaSupplementedRows || 0),
      aida_data_date: input.aidaDataDate || null,
      aida_warning: input.aidaWarning || null,
      measures_imported: false
    },
    sources: [
      {
        id: sourceId,
        type: "TARIC",
        name: "Commissione europea — TARIC raw data",
        url: OFFICIAL_TARIC_PAGE,
        download_library: `https://circabc.europa.eu/ui/group/0e5f18c2-4b2f-42e9-aed4-dfe50ae1263b/library/${CIRCABC_ROOT_ID}`,
        national_verification_url: AIDA_TARIC_PAGE,
        is_official: true,
        current_snapshot: currentVersion,
        italian_snapshot: italianVersion,
        retrieved_at: input.retrievedAt
      },
      {
        id: "adm-aida-taric",
        type: "NATIONAL_TARIC",
        name: "Agenzia delle Dogane e dei Monopoli — AIDA TARIC",
        url: AIDA_TARIC_PAGE,
        is_official: true,
        role: "Supplemento italiano per le righe pubblicate dopo lo snapshot mensile IT",
        supplemented_rows: Number(input.aidaSupplementedRows || 0),
        data_date: input.aidaDataDate || null,
        retrieved_at: input.retrievedAt
      }
    ],
    tariff_codes: records,
    tariff_descriptions: combinedRows.map(row => ({
      code: row.code,
      product_line_id: row.key,
      hierarchy_position: row.hierarchyPosition,
      indent: row.indent,
      description: row.description,
      description_it: row.descriptionIt,
      description_en: row.descriptionEn,
      language: row.selectedLanguage,
      is_declarable: row.isLeaf,
      valid_from: row.startDate || `${input.currentSnapshot.year}-01-01`,
      valid_to: row.endDate,
      source_id: sourceId
    })),
    tariff_hierarchy: hierarchy,
    section_notes: [],
    chapter_notes: [],
    heading_notes: [],
    classification_rules: [],
    classification_examples: [],
    classification_regulations: [],
    bti_examples: [],
    taric_measures: [],
    data_versions: [{
      id: `eu-taric-${currentVersion}`,
      active: true,
      is_official: true,
      italian_snapshot: italianVersion,
      notice: input.aidaSupplementedRows
        ? "Snapshot mensile ufficiale TARIC UE; le righe italiane più recenti sono state integrate dall'indice AIDA aggiornato alla data di acquisizione."
        : "Snapshot mensile ufficiale TARIC UE; le descrizioni italiane usano l'ultima estrazione IT disponibile e ricadono sull'inglese solo per le righe più recenti non ancora pubblicate in IT.",
      valid_from: `${input.currentSnapshot.year}-${input.currentSnapshot.month}-01`,
      valid_to: null,
      ...sourceMetadata
    }]
  };
}

function buildDescriptionPaths(rows) {
  const paths = new Map();
  const stack = [];
  for (const row of rows) {
    if (!row.description) continue;
    const depth = displayDepth(row);
    stack[depth] = row;
    stack.length = depth + 1;
    paths.set(row.key, stack.filter(Boolean).map(item => ({
      code: item.code,
      hierarchyPosition: item.hierarchyPosition,
      description: item.description,
      selectedLanguage: item.selectedLanguage || item.language || "EN"
    })));
  }
  return paths;
}

function displayDepth(row) {
  if (row.hierarchyPosition <= 4) return Math.max(0, row.hierarchyPosition / 2 - 1);
  const dashCount = (String(row.indent || "").match(/-/g) || []).length;
  return Math.max(2, 1 + dashCount);
}

function hierarchyForRecord(code, pathItems) {
  const levels = [
    ["chapter", 2],
    ["hs4", 4],
    ["hs6", 6],
    ["cn", 8],
    ["taric", 10]
  ];
  const result = {};
  for (const [key, length] of levels) {
    const terms = pathItems.filter(item => item.hierarchyPosition <= length).map(item => item.description);
    result[key] = {
      code: code.slice(0, length),
      description: terms.at(-1) || null
    };
  }
  result.taric.description = pathItems.at(-1)?.description || result.taric.description;
  return result;
}

function buildHierarchyTable(records, metadata) {
  const byCode = new Map();
  for (const record of records) {
    for (const [key, length, level] of [
      ["chapter", 2, "CHAPTER"],
      ["hs4", 4, "HS4"],
      ["hs6", 6, "HS6"],
      ["cn", 8, "CN"],
      ["taric", 10, "TARIC"]
    ]) {
      const code = record.code.slice(0, length);
      if (byCode.has(code)) continue;
      const parentLength = ({ 2: 0, 4: 2, 6: 4, 8: 6, 10: 8 })[length];
      byCode.set(code, {
        code,
        parent_code: parentLength ? record.code.slice(0, parentLength) : null,
        level,
        description: record._hierarchy?.[key]?.description || null,
        valid_from: record.valid_from,
        valid_to: record.valid_to,
        ...metadata
      });
    }
  }
  return Array.from(byCode.values()).sort((a, b) => a.code.localeCompare(b.code));
}

function inferFunctions(description) {
  const normalized = normalizeText(description);
  const functions = [];
  if (/cucina|tavola/.test(normalized)) functions.push("uso cucina o tavola");
  if (/cosmetic|bellezza|cura della pelle/.test(normalized)) functions.push("cosmetico e cura personale");
  if (/aliment|mangiare|bevande|preparazioni di ortaggi/.test(normalized)) functions.push("alimentare");
  if (/trasmissione|ricezione|telefon/.test(normalized)) functions.push("telecomunicazioni");
  if (/elaborazione dell informazione/.test(normalized)) functions.push("elaborazione dati");
  return functions;
}

function inferRequiredAttributes(description) {
  const normalized = normalizeText(description);
  const fields = [];
  if (/ di (legno|plastica|acciaio|cotone|lana|vetro|pelle|cuoio)|materie tessili/.test(normalized)) fields.push("material");
  if (/contenent|tenore|percentuale|peso|kg|gramm|litro|cm|mm/.test(normalized)) fields.push("composition_or_size");
  return fields;
}

function validateOfficialDataset(dataset, declarableRows) {
  const expected = declarableRows.filter(row => row.isLeaf).length;
  const codes = dataset.tariff_codes;
  const unique = new Set(codes.map(record => record.code));
  const errors = [];
  if (codes.length !== expected) errors.push(`codici importati ${codes.length}, attesi ${expected}`);
  if (unique.size !== codes.length) errors.push(`codici duplicati ${codes.length - unique.size}`);
  if (codes.some(record => !/^\d{10}$/.test(record.code))) errors.push("sono presenti codici non composti da 10 cifre");
  if (codes.some(record => !record.description)) errors.push("sono presenti descrizioni vuote");
  if (!codes.every(record => record.source_id === "eu-taric-circabc")) errors.push("fonte puntuale mancante");
  if (errors.length) throw new Error(`Dataset TARIC ufficiale non valido: ${errors.join("; ")}.`);
  return true;
}

function parseAtomChildren(xml) {
  const entries = [];
  for (const match of String(xml).matchAll(/<entry\b[\s\S]*?<\/entry>/g)) {
    const block = match[0];
    const titleMatch = block.match(/<title[^>]*>([\s\S]*?)<\/title>/);
    const selfMatch = block.match(/<link[^>]+rel=["']self["'][^>]+href=["']([^"']+)["']/) ||
      block.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']self["']/);
    const contentMatch = block.match(/<content[^>]+type=["']([^"']+)["']/);
    const idMatch = selfMatch?.[1]?.match(/SpacesStore\/i\/([0-9a-f-]{36})/i);
    if (!titleMatch || !idMatch) continue;
    entries.push({
      title: decodeXml(titleMatch[1].replace(/<[^>]+>/g, "")),
      nodeId: idMatch[1],
      mimeType: contentMatch?.[1] || null
    });
  }
  return entries;
}

function canonicalFileName(value) {
  return String(value || "").replace(/\s*\(\d+\)(?=\.xlsx$)/i, "");
}

function decodeXml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

function cellText(value) {
  if (value == null) return "";
  if (typeof value === "object") {
    if (Array.isArray(value.richText)) return value.richText.map(part => part.text || "").join("");
    if ("text" in value) return value.text;
    if ("result" in value) return value.result;
  }
  return String(value);
}

function cleanDescription(value) {
  return sanitizeText(String(value || "").replace(/\|/g, " "), 1000);
}

function toIsoDate(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (match) return `${match[3]}-${match[2]}-${match[1]}`;
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return iso ? iso[0] : null;
}

function safeTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

module.exports = {
  OfficialTaricImporter,
  buildOfficialDataset,
  buildDescriptionPaths,
  displayDepth,
  parseAtomChildren,
  readNomenclatureWorkbook,
  readDeclarableWorkbook,
  validateOfficialDataset
};
