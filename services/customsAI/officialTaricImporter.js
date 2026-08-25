"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { AidaNomenclatureClient } = require("./aidaNomenclatureClient");
const { aliasesForRecord, inferMaterials } = require("./searchLexicon");
const { normalizeCode, normalizeText, sanitizeText, uniqueStrings } = require("./textUtils");

const CIRCABC_ROOT_ID = "64db9d0f-e7c9-4084-afe9-f47e70e53c10";
const CIRCABC_API = "https://circabc.europa.eu/service/api/node/workspace/SpacesStore";
const OFFICIAL_TARIC_PAGE = "https://taxation-customs.ec.europa.eu/customs/common-customs-tariff-cct/tariff-classification-goods/eu-customs-tariff-taric_en?prefLang=it";
const AIDA_TARIC_PAGE = "https://aidaonline7.adm.gov.it/nsitaricinternet/TaricServlet";

const SUPPLEMENTARY_UNIT_METADATA = Object.freeze({
  GRM: { description: "Grammo", symbol: "g" },
  KGM: { description: "Chilogrammo", symbol: "kg" },
  LTR: { description: "Litro", symbol: "l" },
  MTK: { description: "Metro quadrato", symbol: "m²" },
  MTQ: { description: "Metro cubo", symbol: "m³" },
  MTR: { description: "Metro", symbol: "m" },
  MWH: { description: "Megawattora", symbol: "MWh" },
  NAR: { description: "Numero di pezzi", symbol: "p/st", declaration_code: "PCE" }
});

class OfficialTaricImporter {
  constructor(options = {}) {
    this.fetch = options.fetch || global.fetch;
    this.fs = options.fs || fs;
    this.now = options.now || (() => new Date());
    this.userAgent = options.userAgent || "DoganaTools-TARIC-Updater/1.0";
    if (typeof this.fetch !== "function") throw new Error("Fetch non disponibile: serve Node.js 20 o successivo.");
  }

  async update(options = {}) {
    const onProgress = typeof options.onProgress === "function" ? options.onProgress : () => {};
    const rootDir = path.resolve(options.rootDir || path.resolve(__dirname, "../.."));
    const cacheDir = path.resolve(options.cacheDir || path.join(rootDir, "cache", "taric-official"));
    const targetPath = path.resolve(options.targetPath || path.join(rootDir, "data", "customs", "runtime", "customs-dataset.json"));
    this.fs.mkdirSync(cacheDir, { recursive: true });

    onProgress("Ricerca dell'ultimo snapshot TARIC completo");
    const snapshot = await this.resolveSnapshot(options);
    const currentPrefix = `${snapshot.current.year}-${snapshot.current.month}`;
    const italianPrefix = `${snapshot.italian.year}-${snapshot.italian.month}`;
    const files = {
      nomenclatureEn: path.join(cacheDir, `${currentPrefix}-nomenclature-en.xlsx`),
      declarableCodes: path.join(cacheDir, `${currentPrefix}-declarable-codes.xlsx`),
      nomenclatureIt: path.join(cacheDir, `${italianPrefix}-nomenclature-it.xlsx`),
      additionalCodes: path.join(cacheDir, `${currentPrefix}-additional-codes.xlsx`),
      documentCodes: path.join(cacheDir, `${currentPrefix}-box-44-codes.xlsx`),
      geographicalAreas: path.join(cacheDir, `${currentPrefix}-geographical-areas.xlsx`),
      footnotes: path.join(cacheDir, `${currentPrefix}-footnotes.xlsx`),
      measureExclusions: path.join(cacheDir, `${currentPrefix}-measure-exclusions.xlsx`),
      measureFootnotes: path.join(cacheDir, `${currentPrefix}-measure-footnotes.xlsx`),
      measureConditions: path.join(cacheDir, `${currentPrefix}-measure-conditions.xlsx`)
    };

    const refreshFiles = options.reuseCache !== true;
    onProgress("Download della nomenclatura ufficiale");
    await this.download(snapshot.current.files.get("Nomenclature EN.xlsx"), files.nomenclatureEn, refreshFiles || options.force);
    await this.download(snapshot.current.files.get("Declarable codes.xlsx"), files.declarableCodes, refreshFiles || options.force);
    await this.download(snapshot.italian.files.get("Nomenclature IT.xlsx"), files.nomenclatureIt, refreshFiles || options.force);

    const measuresEnabled = options.measures !== false;
    let measureFiles = null;
    if (measuresEnabled) {
      const requiredMeasureFiles = {
        additionalCodes: findSnapshotFile(snapshot.current.files, /^Additional codes(?: descriptions)?\.xlsx$/i),
        documentCodes: findSnapshotFile(snapshot.current.files, /^(Box 44|Supporting document).*\.xlsx$/i),
        geographicalAreas: findSnapshotFile(snapshot.current.files, /^Geographical areas? composition\.xlsx$/i),
        footnotes: findSnapshotFile(snapshot.current.files, /^Footnotes(?: descriptions)?\.xlsx$/i),
        measureExclusions: findSnapshotFile(snapshot.current.files, /^Measure exclusions\.xlsx$/i),
        measureFootnotes: findSnapshotFile(snapshot.current.files, /^Measure footnotes\.xlsx$/i),
        measureConditions: findSnapshotFile(snapshot.current.files, /^Measure conditions\.xlsx$/i)
      };
      const dutiesImport = findSnapshotFiles(snapshot.current.files, /^Duties Import.*\.xlsx$/i);
      const dutiesExport = findSnapshotFiles(snapshot.current.files, /^Duties Export.*\.xlsx$/i);
      const missing = Object.entries(requiredMeasureFiles).filter(([, file]) => !file).map(([name]) => name);
      if (!dutiesImport.length) missing.push("dutiesImport");
      if (!dutiesExport.length) missing.push("dutiesExport");
      if (missing.length) {
        throw new Error(`Snapshot TARIC incompleto per le misure: ${missing.join(", ")}.`);
      }
      onProgress("Download delle tabelle import/export e delle condizioni");
      for (const [name, file] of Object.entries(requiredMeasureFiles)) {
        await this.download(file, files[name], refreshFiles || options.force);
      }
      const importPaths = await downloadMeasureSeries(this, dutiesImport, cacheDir, currentPrefix, "duties-import", refreshFiles || options.force);
      const exportPaths = await downloadMeasureSeries(this, dutiesExport, cacheDir, currentPrefix, "duties-export", refreshFiles || options.force);
      measureFiles = { ...files, importPaths, exportPaths };
    }

    onProgress("Lettura sequenziale della nomenclatura");
    let englishRows = await readNomenclatureWorkbook(files.nomenclatureEn);
    let italianRows = await readNomenclatureWorkbook(files.nomenclatureIt);
    let declarableRows = await readDeclarableWorkbook(files.declarableCodes);
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
    const declarableLeafCount = declarableRows.filter(row => row.isLeaf).length;
    onProgress("Costruzione dell'indice doganale");
    const dataset = buildOfficialDataset({
      englishRows,
      italianRows: supplementedItalianRows,
      declarableRows,
      currentSnapshot: snapshot.current,
      italianSnapshot: snapshot.italian,
      aidaSupplementedRows,
      aidaDataDate,
      aidaWarning,
      measureTables: null,
      retrievedAt
    });
    englishRows = null;
    italianRows = null;
    supplementedItalianRows = null;
    declarableRows = null;

    if (measureFiles) {
      onProgress("Importazione streaming delle misure TARIC");
      attachTaricMeasureTables(dataset, await readTaricMeasureWorkbooks(measureFiles, onProgress));
    }
    if (measuresEnabled && dataset.coverage.measures === 0) {
      throw new Error("Le estrazioni ufficiali non hanno prodotto alcuna misura TARIC.");
    }
    validateOfficialDataset(dataset, declarableLeafCount);

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
      measures: dataset.coverage.measures,
      additionalCodes: dataset.additional_codes.length,
      aidaSupplementedRows,
      aidaDataDate,
      aidaWarning,
      retrievedAt,
      backupPath: null,
      measureBackupPath: null
    };
    if (options.dryRun) return { dataset, report };

    const targetDirectory = path.dirname(targetPath);
    this.fs.mkdirSync(targetDirectory, { recursive: true });
    const tempPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
    const measureDirectoryName = "taric-measures";
    const measureDirectory = path.join(targetDirectory, measureDirectoryName);
    const tempMeasureDirectory = `${measureDirectory}.tmp-${process.pid}-${Date.now()}`;
    let hasTemporaryMeasures = false;
    try {
      if (dataset.coverage.measures > 0) {
        onProgress("Scrittura delle misure separate per capitolo HS");
        await writeMeasureShards(this.fs, tempMeasureDirectory, dataset.taric_measures, {
          sourceVersion: currentPrefix,
          retrievedAt
        });
        hasTemporaryMeasures = true;
        dataset.taric_measures = [];
        dataset.coverage.measures_storage = "chapter_files";
        dataset.coverage.measures_directory = measureDirectoryName;
      }
      onProgress("Scrittura progressiva del database locale");
      await writeJsonFile(this.fs, tempPath, dataset);
    } catch (error) {
      try { if (this.fs.existsSync(tempPath)) this.fs.unlinkSync(tempPath); } catch {}
      try { if (this.fs.existsSync(tempMeasureDirectory)) this.fs.rmSync(tempMeasureDirectory, { recursive: true, force: true }); } catch {}
      throw error;
    }
    let backupPath = null;
    let measureBackupPath = null;
    let measuresActivated = false;
    try {
      const backupDir = path.join(targetDirectory, "backups");
      if (this.fs.existsSync(targetPath) || (hasTemporaryMeasures && this.fs.existsSync(measureDirectory))) {
        this.fs.mkdirSync(backupDir, { recursive: true });
      }
      if (this.fs.existsSync(targetPath)) {
        backupPath = path.join(backupDir, `customs-dataset-${safeTimestamp()}.json`);
        this.fs.renameSync(targetPath, backupPath);
      }
      if (hasTemporaryMeasures) {
        if (this.fs.existsSync(measureDirectory)) {
          measureBackupPath = path.join(backupDir, `taric-measures-${safeTimestamp()}`);
          this.fs.renameSync(measureDirectory, measureBackupPath);
        }
        this.fs.renameSync(tempMeasureDirectory, measureDirectory);
        measuresActivated = true;
      }
      this.fs.renameSync(tempPath, targetPath);
    } catch (error) {
      try {
        if (measuresActivated && this.fs.existsSync(measureDirectory)) {
          this.fs.rmSync(measureDirectory, { recursive: true, force: true });
        }
        if (measureBackupPath && !this.fs.existsSync(measureDirectory) && this.fs.existsSync(measureBackupPath)) {
          this.fs.renameSync(measureBackupPath, measureDirectory);
        }
        if (backupPath && !this.fs.existsSync(targetPath) && this.fs.existsSync(backupPath)) {
          this.fs.renameSync(backupPath, targetPath);
        }
      } catch {}
      try { if (this.fs.existsSync(tempPath)) this.fs.unlinkSync(tempPath); } catch {}
      try { if (this.fs.existsSync(tempMeasureDirectory)) this.fs.rmSync(tempMeasureDirectory, { recursive: true, force: true }); } catch {}
      throw error;
    }
    report.backupPath = backupPath;
    report.measureBackupPath = measureBackupPath;
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
      const baseFilesComplete = files.has("Nomenclature EN.xlsx") && files.has("Declarable codes.xlsx");
      const measuresComplete = options.measures === false || snapshotHasMeasureFiles(files);
      if (!current && baseFilesComplete && measuresComplete) current = enriched;
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
  const rows = [];
  await forEachWorkbookRow(filePath, (row, sheetIndex) => {
    if (sheetIndex !== 0 || row.number === 1) return;
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
  }, { firstSheetOnly: true });
  return rows;
}

async function readDeclarableWorkbook(filePath) {
  const rows = [];
  await forEachWorkbookRow(filePath, (row, sheetIndex) => {
    if (sheetIndex !== 0 || row.number === 1) return;
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
  }, { firstSheetOnly: true });
  return rows;
}

async function readTaricMeasureWorkbooks(files, onProgress = () => {}) {
  onProgress("Indicizzazione dei codici addizionali");
  const additional_codes = descriptionsByLanguage(
    await readPlainWorkbook(files.additionalCodes),
    "additional_code",
    true
  );
  onProgress("Indicizzazione dei documenti doganali");
  const document_codes = descriptionsByLanguage(
    await readPlainWorkbook(files.documentCodes),
    "document_code",
    true
  );
  const geographical_areas = buildGeographicalAreas(await readPlainWorkbook(files.geographicalAreas));
  onProgress("Indicizzazione delle note TARIC");
  const footnotes = descriptionsByLanguage(await readPlainWorkbook(files.footnotes), "footnote", true);
  const exclusions = groupMeasureRows(await readPlainWorkbook(files.measureExclusions), parseMeasureExclusion);
  const measureFootnotes = groupMeasureRows(await readPlainWorkbook(files.measureFootnotes), parseMeasureFootnote);
  const conditions = groupMeasureRows(await readPlainWorkbook(files.measureConditions), parseMeasureCondition);
  const context = createDutyParsingContext({ conditions, exclusions, measureFootnotes, footnotes });
  const taric_measures = [];
  await appendDutyWorkbookSeries(files.importPaths, "import", context, taric_measures, onProgress);
  await appendDutyWorkbookSeries(files.exportPaths, "export", context, taric_measures, onProgress);
  return { taric_measures, additional_codes, document_codes, footnotes, geographical_areas };
}

async function readPlainWorkbook(filePath) {
  const rows = [];
  await forEachWorkbookRow(filePath, row => {
    if (row.number === 1) return;
    const values = plainRowValues(row);
    if (values.some(Boolean)) rows.push(values);
  });
  return rows;
}

async function appendDutyWorkbookSeries(paths, flow, context, target, onProgress) {
  for (let index = 0; index < (paths || []).length; index += 1) {
    onProgress(`Lettura misure ${flow} (${index + 1}/${paths.length})`);
    await forEachWorkbookRow(paths[index], row => {
      if (row.number === 1) return;
      const values = plainRowValues(row);
      if (!values.some(Boolean)) return;
      const measure = parseDutyRow(values, flow, context);
      if (measure) target.push(measure);
    });
  }
}

async function forEachWorkbookRow(filePath, visitor, options = {}) {
  const workbook = createWorkbookReader(filePath);
  let sheetCount = 0;
  for await (const sheet of workbook) {
    const sheetIndex = sheetCount;
    sheetCount += 1;
    for await (const row of sheet) {
      if (!options.firstSheetOnly || sheetIndex === 0) visitor(row, sheetIndex);
    }
  }
  if (!sheetCount) throw new Error(`Foglio mancante in ${filePath}.`);
}

function plainRowValues(row) {
  const values = [];
  for (let index = 1; index <= Math.max(15, row.cellCount); index += 1) {
    values.push(sanitizeText(cellText(row.getCell(index).value), 2000));
  }
  return values;
}

function buildTaricMeasureTables(input = {}) {
  const additional_codes = descriptionsByLanguage(input.additionalRows, "additional_code", true);
  const document_codes = descriptionsByLanguage(input.documentRows, "document_code", true);
  const footnotes = descriptionsByLanguage(input.footnoteRows, "footnote", true);
  const geographical_areas = buildGeographicalAreas(input.geographicalRows || []);
  const conditions = groupMeasureRows(input.conditionRows || [], parseMeasureCondition);
  const exclusions = groupMeasureRows(input.exclusionRows || [], parseMeasureExclusion);
  const measureFootnotes = groupMeasureRows(input.measureFootnoteRows || [], parseMeasureFootnote);
  const context = createDutyParsingContext({ conditions, exclusions, measureFootnotes, footnotes });
  const parseDuties = (rows, flow) => (rows || []).map(row => parseDutyRow(row, flow, context)).filter(Boolean);
  return {
    taric_measures: [...parseDuties(input.importRows, "import"), ...parseDuties(input.exportRows, "export")],
    additional_codes,
    document_codes,
    footnotes,
    geographical_areas
  };
}

function createDutyParsingContext(input) {
  return {
    conditions: input.conditions || new Map(),
    exclusions: input.exclusions || new Map(),
    measureFootnotes: input.measureFootnotes || new Map(),
    footnoteByCode: new Map((input.footnotes || []).map(item => [item.code, item]))
  };
}

function parseDutyRow(row, flow, context) {
  const code = normalizeCode(row[0]).padEnd(10, "0");
  const additionalCode = sanitizeText(row[1], 4).toUpperCase() || null;
  const orderNumber = sanitizeText(row[2], 24) || null;
  const validFrom = toIsoDate(row[3]);
  const validTo = toIsoDate(row[4]) || null;
  const geographicalAreaCode = sanitizeText(row[10], 24) || null;
  const measureTypeCode = sanitizeText(row[11], 12) || null;
  if (!/^\d{10}$/.test(code) || !validFrom || !measureTypeCode) return null;
  const key = measureIdentity(code, additionalCode, orderNumber, validFrom, geographicalAreaCode, measureTypeCode);
  const duty = sanitizeText(row[9], 1000) || null;
  const parsedConditions = mergeMeasureConditions(
    context.conditions.get(key) || [],
    parseInlineMeasureConditions(duty)
  );
  const measureType = sanitizeText(row[7], 500) || null;
  const exclusions = context.exclusions.get(key) || [];
  return compactObject({
    id: `${flow}:${key}`,
    code,
    additional_code: additionalCode,
    order_number: orderNumber,
    valid_from: validFrom,
    valid_to: validTo,
    reduction_indicator: sanitizeText(row[5], 20) || null,
    geographical_area: sanitizeText(row[6], 300) || null,
    geographical_area_code: geographicalAreaCode,
    measure_type: measureType,
    measure_type_code: measureTypeCode,
    legal_reference: sanitizeText(row[8], 500) || null,
    duty,
    flow,
    conditions: parsedConditions,
    supplementary_units: parseSupplementaryUnits(measureType, duty, parsedConditions),
    exclusions,
    excluded_countries: uniqueStrings(exclusions.map(item => item.country_code), 8),
    footnotes: (context.measureFootnotes.get(key) || []).map(item => ({
      code: item.code,
      description: context.footnoteByCode.get(item.code)?.description || null
    }))
  });
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => (
    item !== null && item !== undefined && item !== "" && (!Array.isArray(item) || item.length > 0)
  )));
}

function descriptionsByLanguage(rows, type, withDates = false) {
  const grouped = new Map();
  for (const row of rows || []) {
    const code = sanitizeText(row[0], 24).toUpperCase();
    const language = sanitizeText(row[1], 4).toUpperCase();
    const description = sanitizeText(row[2], 2000);
    if (!code || !description) continue;
    const current = grouped.get(code);
    const preferred = !current || language === "IT" || (current.language !== "IT" && language === "EN");
    if (preferred) {
      grouped.set(code, {
        code,
        type,
        language,
        description,
        ...(withDates ? {
          valid_from: toIsoDate(row[3]),
          description_valid_from: toIsoDate(row[4]),
          valid_to: toIsoDate(row[5]) || null
        } : {})
      });
    }
  }
  return Array.from(grouped.values()).sort((left, right) => left.code.localeCompare(right.code));
}

function buildGeographicalAreas(rows) {
  const groups = new Map();
  for (const row of rows || []) {
    const code = sanitizeText(row[0], 24);
    const language = sanitizeText(row[2], 4).toUpperCase();
    const memberCode = sanitizeText(row[6], 8).toUpperCase();
    if (!code || !memberCode) continue;
    if (!groups.has(code)) {
      groups.set(code, {
        code,
        valid_from: toIsoDate(row[1]),
        acronym: sanitizeText(row[3], 24) || null,
        description: sanitizeText(row[4], 500) || null,
        language,
        members: []
      });
    }
    const group = groups.get(code);
    if (language === "IT" || !group.description) {
      group.acronym = sanitizeText(row[3], 24) || group.acronym;
      group.description = sanitizeText(row[4], 500) || group.description;
      group.language = language || group.language;
    }
    if (!group.members.some(member => member.code === memberCode && member.valid_from === toIsoDate(row[8]))) {
      group.members.push({
        code: memberCode,
        description: sanitizeText(row[7], 300) || null,
        valid_from: toIsoDate(row[8]),
        valid_to: toIsoDate(row[9]) || null
      });
    }
  }
  return Array.from(groups.values());
}

function groupMeasureRows(rows, parser) {
  const result = new Map();
  for (const row of rows) {
    const parsed = parser(row);
    if (!parsed) continue;
    const list = result.get(parsed.key) || [];
    list.push(parsed.value);
    result.set(parsed.key, list);
  }
  return result;
}

function parseMeasureCondition(row) {
  const code = normalizeCode(row[0]).padEnd(10, "0");
  const validFrom = toIsoDate(row[3]);
  const areaCode = sanitizeText(row[5], 24) || null;
  const measureTypeCode = sanitizeText(row[6], 12) || null;
  if (!/^\d{10}$/.test(code) || !validFrom || !measureTypeCode) return null;
  return {
    key: measureIdentity(code, row[1], row[2], validFrom, areaCode, measureTypeCode),
    value: {
      condition_code: sanitizeText(row[7], 8) || null,
      sequence: Number(row[8]) || null,
      certificate_code: sanitizeText(row[9], 24).toUpperCase() || null,
      amount: sanitizeText(row[10], 80) || null,
      monetary_unit: sanitizeText(row[11], 20) || null,
      measurement_unit: sanitizeText(row[12], 20) || null,
      measurement_unit_qualifier: sanitizeText(row[13], 20) || null,
      action_code: sanitizeText(row[14], 20) || null
    }
  };
}

function parseInlineMeasureConditions(value) {
  const duty = sanitizeText(value, 2000);
  if (!/^Cond\s*:/i.test(duty)) return [];
  const sequences = new Map();
  return duty.replace(/^Cond\s*:\s*/i, "")
    .split(";")
    .map(rawPart => sanitizeText(rawPart, 500))
    .filter(Boolean)
    .map(rawPart => {
      const match = rawPart.match(/^([A-Z])(?:\s+cert\s*:\s*([A-Z0-9-]+))?\s*(.*)$/i);
      if (!match) return null;
      const conditionCode = match[1].toUpperCase();
      const certificateCode = String(match[2] || "").replace(/[^A-Z0-9]/gi, "").toUpperCase() || null;
      const expression = sanitizeText(match[3], 400);
      const actionMatch = expression.match(/\((\d{2})\)\s*:/);
      const rateExpression = sanitizeText(expression.replace(/\(\d{2}\)\s*:[\s\S]*$/, ""), 200) || null;
      const monetaryAndMeasurement = rateExpression?.match(/\b([A-Z]{3})\s*\/\s*([A-Z]{3})(?:\s+([A-Z]))?/i);
      const measurementOnly = monetaryAndMeasurement
        ? null
        : rateExpression?.match(/\/\s*([A-Z]{3})(?:\s+([A-Z]))?/i);
      const amountMatch = rateExpression?.match(/[+-]?\d+(?:[.,]\d+)?/);
      const sequence = (sequences.get(conditionCode) || 0) + 1;
      sequences.set(conditionCode, sequence);
      return {
        condition_code: conditionCode,
        sequence,
        certificate_code: certificateCode,
        amount: amountMatch?.[0] || null,
        monetary_unit: monetaryAndMeasurement?.[1]?.toUpperCase() || null,
        measurement_unit: (monetaryAndMeasurement?.[2] || measurementOnly?.[1] || "").toUpperCase() || null,
        measurement_unit_qualifier: (monetaryAndMeasurement?.[3] || measurementOnly?.[2] || "").toUpperCase() || null,
        action_code: actionMatch?.[1] || null,
        expression: rateExpression,
        raw: rawPart,
        source: "duty_expression"
      };
    })
    .filter(Boolean);
}

function mergeMeasureConditions(...groups) {
  const merged = [];
  const seen = new Set();
  for (const condition of groups.flat()) {
    const key = [
      condition.condition_code,
      condition.certificate_code,
      condition.amount,
      condition.monetary_unit,
      condition.measurement_unit,
      condition.measurement_unit_qualifier,
      condition.action_code
    ].map(value => String(value || "").toUpperCase()).join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(condition);
  }
  return merged;
}

function parseSupplementaryUnits(measureType, duty, conditions = []) {
  if (!/supplementary\s+unit|unit[àa]\s+supplementare/i.test(String(measureType || ""))) return [];
  const units = [];
  const direct = String(duty || "").trim().match(/^([A-Z]{3})(?:\s+([A-Z]))?$/i);
  if (direct) units.push({ code: direct[1].toUpperCase(), qualifier: direct[2]?.toUpperCase() || null });
  for (const condition of conditions) {
    if (!condition.measurement_unit) continue;
    units.push({
      code: String(condition.measurement_unit).toUpperCase(),
      qualifier: String(condition.measurement_unit_qualifier || "").toUpperCase() || null
    });
  }
  const unique = new Map();
  for (const unit of units) {
    const metadata = SUPPLEMENTARY_UNIT_METADATA[unit.code] || {};
    const normalized = {
      code: unit.code,
      qualifier: unit.qualifier,
      declaration_code: metadata.declaration_code || null,
      description: metadata.description || null,
      symbol: metadata.symbol || null
    };
    unique.set(`${normalized.code}|${normalized.qualifier || ""}`, normalized);
  }
  return Array.from(unique.values());
}

function parseMeasureExclusion(row) {
  const code = normalizeCode(row[0]).padEnd(10, "0");
  const validFrom = toIsoDate(row[3]);
  const areaCode = sanitizeText(row[8], 24) || null;
  const measureTypeCode = sanitizeText(row[9], 12) || null;
  if (!/^\d{10}$/.test(code) || !validFrom || !measureTypeCode) return null;
  return {
    key: measureIdentity(code, row[1], row[2], validFrom, areaCode, measureTypeCode),
    value: {
      country: sanitizeText(row[7], 300) || null,
      country_code: sanitizeText(row[10], 8).toUpperCase() || null
    }
  };
}

function parseMeasureFootnote(row) {
  const code = normalizeCode(row[0]).padEnd(10, "0");
  const validFrom = toIsoDate(row[4]);
  const areaCode = sanitizeText(row[3], 24) || null;
  const measureTypeCode = sanitizeText(row[6], 12) || null;
  const footnoteCode = sanitizeText(row[9], 24).toUpperCase();
  if (!/^\d{10}$/.test(code) || !validFrom || !measureTypeCode || !footnoteCode) return null;
  return {
    key: measureIdentity(code, row[1], row[2], validFrom, areaCode, measureTypeCode),
    value: { code: footnoteCode }
  };
}

function measureIdentity(code, additionalCode, orderNumber, validFrom, areaCode, measureTypeCode) {
  return [
    normalizeCode(code).padEnd(10, "0"),
    sanitizeText(additionalCode, 4).toUpperCase(),
    sanitizeText(orderNumber, 24),
    validFrom || "",
    sanitizeText(areaCode, 24),
    sanitizeText(measureTypeCode, 12)
  ].join("|");
}

function emptyMeasureTables() {
  return {
    taric_measures: [],
    additional_codes: [],
    document_codes: [],
    footnotes: [],
    geographical_areas: []
  };
}

function attachTaricMeasureTables(dataset, tables) {
  const measureTables = tables || emptyMeasureTables();
  dataset.taric_measures = measureTables.taric_measures;
  dataset.additional_codes = measureTables.additional_codes;
  dataset.document_codes = measureTables.document_codes;
  dataset.footnotes = measureTables.footnotes;
  dataset.geographical_areas = measureTables.geographical_areas;
  dataset.coverage.measures_imported = measureTables.taric_measures.length > 0;
  dataset.coverage.measures = measureTables.taric_measures.length;
  dataset.coverage.additional_codes = measureTables.additional_codes.length;
  dataset.coverage.document_codes = measureTables.document_codes.length;
  dataset.coverage.geographical_areas = measureTables.geographical_areas.length;
  return dataset;
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
  const measureTables = input.measureTables || emptyMeasureTables();
  return {
    schema_version: 3,
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
      measures_imported: measureTables.taric_measures.length > 0,
      measures: measureTables.taric_measures.length,
      additional_codes: measureTables.additional_codes.length,
      document_codes: measureTables.document_codes.length,
      geographical_areas: measureTables.geographical_areas.length
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
    taric_measures: measureTables.taric_measures,
    additional_codes: measureTables.additional_codes,
    document_codes: measureTables.document_codes,
    footnotes: measureTables.footnotes,
    geographical_areas: measureTables.geographical_areas,
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
  const expected = Array.isArray(declarableRows)
    ? declarableRows.filter(row => row.isLeaf).length
    : Number(declarableRows);
  const codes = dataset.tariff_codes;
  const unique = new Set(codes.map(record => record.code));
  const errors = [];
  if (codes.length !== expected) errors.push(`codici importati ${codes.length}, attesi ${expected}`);
  if (unique.size !== codes.length) errors.push(`codici duplicati ${codes.length - unique.size}`);
  if (codes.some(record => !/^\d{10}$/.test(record.code))) errors.push("sono presenti codici non composti da 10 cifre");
  if (codes.some(record => !record.description)) errors.push("sono presenti descrizioni vuote");
  if (!codes.every(record => record.source_id === "eu-taric-circabc")) errors.push("fonte puntuale mancante");
  if ((dataset.taric_measures || []).some(measure => !/^\d{10}$/.test(measure.code) || !measure.flow || !measure.measure_type_code)) {
    errors.push("sono presenti misure TARIC incomplete o con codice non valido");
  }
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

function createWorkbookReader(filePath) {
  const { stream } = require("exceljs");
  if (!stream?.xlsx?.WorkbookReader) {
    throw new Error("La versione di exceljs installata non supporta la lettura streaming. Aggiorna exceljs alla versione 4.");
  }
  return new stream.xlsx.WorkbookReader(filePath, {
    worksheets: "emit",
    sharedStrings: "cache",
    hyperlinks: "ignore",
    styles: "ignore",
    entries: "ignore"
  });
}

function findSnapshotFile(files, pattern) {
  for (const [name, file] of files || []) {
    if (pattern.test(name)) return file;
  }
  return null;
}

function findSnapshotFiles(files, pattern) {
  return Array.from(files || [])
    .filter(([name]) => pattern.test(name))
    .map(([, file]) => file)
    .sort((left, right) => String(left.title).localeCompare(String(right.title)));
}

function snapshotHasMeasureFiles(files) {
  return Boolean(
    findSnapshotFile(files, /^Additional codes(?: descriptions)?\.xlsx$/i) &&
    findSnapshotFile(files, /^(Box 44|Supporting document).*\.xlsx$/i) &&
    findSnapshotFile(files, /^Geographical areas? composition\.xlsx$/i) &&
    findSnapshotFile(files, /^Footnotes(?: descriptions)?\.xlsx$/i) &&
    findSnapshotFile(files, /^Measure exclusions\.xlsx$/i) &&
    findSnapshotFile(files, /^Measure footnotes\.xlsx$/i) &&
    findSnapshotFile(files, /^Measure conditions\.xlsx$/i) &&
    findSnapshotFiles(files, /^Duties Import.*\.xlsx$/i).length &&
    findSnapshotFiles(files, /^Duties Export.*\.xlsx$/i).length
  );
}

async function downloadMeasureSeries(importer, entries, cacheDir, prefix, stem, force) {
  const targets = [];
  for (let index = 0; index < entries.length; index += 1) {
    const target = path.join(cacheDir, `${prefix}-${stem}-${String(index + 1).padStart(2, "0")}.xlsx`);
    await importer.download(entries[index], target, force);
    targets.push(target);
  }
  return targets;
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
  if (iso) return iso[0];
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

async function writeJsonFile(fsModule, filePath, value) {
  if (typeof fsModule.createWriteStream !== "function") {
    fsModule.writeFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
    return;
  }
  const output = fsModule.createWriteStream(filePath, { encoding: "utf8" });
  let streamError = null;
  output.on("error", error => { streamError = error; });
  const waitFor = eventName => new Promise((resolve, reject) => {
    if (streamError) return reject(streamError);
    const onEvent = () => {
      output.off("error", onError);
      resolve();
    };
    const onError = error => {
      output.off(eventName, onEvent);
      reject(error);
    };
    output.once(eventName, onEvent);
    output.once("error", onError);
  });
  const write = async chunk => {
    if (streamError) throw streamError;
    if (!output.write(chunk)) await waitFor("drain");
  };
  const entries = Object.entries(value);
  await write("{");
  for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
    const [key, item] = entries[entryIndex];
    if (entryIndex) await write(",");
    await write(`${JSON.stringify(key)}:`);
    if (!Array.isArray(item)) {
      await write(JSON.stringify(item));
      continue;
    }
    let buffer = "[";
    for (let itemIndex = 0; itemIndex < item.length; itemIndex += 1) {
      const serialized = `${itemIndex ? "," : ""}${JSON.stringify(item[itemIndex])}`;
      if (buffer.length + serialized.length > 256 * 1024) {
        await write(buffer);
        buffer = "";
      }
      buffer += serialized;
    }
    buffer += "]";
    await write(buffer);
  }
  await write("}\n");
  const finished = waitFor("finish");
  output.end();
  await finished;
}

async function writeMeasureShards(fsModule, directoryPath, measures, metadata = {}) {
  fsModule.mkdirSync(directoryPath, { recursive: true });
  const chapters = new Map();
  for (const measure of measures || []) {
    const chapter = normalizeCode(measure.code).slice(0, 2);
    if (!/^\d{2}$/.test(chapter)) continue;
    const list = chapters.get(chapter) || [];
    list.push(measure);
    chapters.set(chapter, list);
  }
  const manifestChapters = {};
  for (const [chapter, chapterMeasures] of Array.from(chapters.entries()).sort()) {
    manifestChapters[chapter] = chapterMeasures.length;
    await writeJsonFile(fsModule, path.join(directoryPath, `${chapter}.json`), {
      schema_version: 1,
      chapter,
      measures: chapterMeasures
    });
  }
  await writeJsonFile(fsModule, path.join(directoryPath, "manifest.json"), {
    schema_version: 1,
    source_version: metadata.sourceVersion || null,
    retrieved_at: metadata.retrievedAt || null,
    measures: measures.length,
    chapters: manifestChapters
  });
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
  readTaricMeasureWorkbooks,
  buildTaricMeasureTables,
  parseInlineMeasureConditions,
  parseSupplementaryUnits,
  measureIdentity,
  validateOfficialDataset
};
