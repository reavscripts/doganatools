"use strict";

const fs = require("fs");
const path = require("path");
const { REQUIRED_TABLES } = require("../../repositories/tariffRepository");
const { normalizeCode, sanitizeText, uniqueStrings } = require("./textUtils");

class CustomsDataImporter {
  constructor(options = {}) {
    this.fs = options.fs || fs;
  }

  importFile(options) {
    const startedAt = new Date().toISOString();
    const sourcePath = path.resolve(options.sourcePath);
    const targetPath = path.resolve(options.targetPath);
    if (!this.fs.existsSync(sourcePath)) throw new Error(`File sorgente non trovato: ${sourcePath}`);

    const raw = this.fs.readFileSync(sourcePath, "utf8");
    const parsed = path.extname(sourcePath).toLowerCase() === ".csv"
      ? this.fromCsv(raw, options)
      : JSON.parse(raw);
    const normalized = this.normalizeDataset(parsed, {
      source: options.source || parsed.source || "IMPORTED DATA — source da verificare",
      sourceVersion: options.sourceVersion || parsed.source_version || path.basename(sourcePath),
      retrievedAt: options.retrievedAt || new Date().toISOString(),
      validFrom: options.validFrom || parsed.valid_from || new Date().toISOString().slice(0, 10),
      validTo: options.validTo ?? parsed.valid_to ?? null,
      official: options.official === true
    });
    this.validate(normalized);

    const report = {
      success: true,
      dryRun: options.dryRun === true,
      sourcePath,
      targetPath,
      startedAt,
      finishedAt: new Date().toISOString(),
      backupPath: null,
      counts: Object.fromEntries(REQUIRED_TABLES.map(table => [table, normalized[table].length])),
      version: normalized.data_versions.find(item => item.active) || normalized.data_versions[0]
    };
    if (options.dryRun) return { report, dataset: normalized };

    this.fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    const tempPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
    this.fs.writeFileSync(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
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
    report.finishedAt = new Date().toISOString();
    return { report, dataset: normalized };
  }

  normalizeDataset(input, metadata) {
    const base = input && typeof input === "object" && !Array.isArray(input) ? input : {};
    const dataset = {
      schema_version: Number(base.schema_version || 1),
      dataset_status: metadata.official ? "official" : (base.dataset_status || "imported_unverified"),
      notice: sanitizeText(base.notice || (metadata.official
        ? "Dataset importato da fonte dichiarata ufficiale; verificare il report di validazione."
        : "Dati importati non verificati come fonte ufficiale."), 500),
      sources: Array.isArray(base.sources) ? base.sources : []
    };
    for (const table of REQUIRED_TABLES) dataset[table] = Array.isArray(base[table]) ? base[table] : [];

    dataset.tariff_codes = dataset.tariff_codes.map(record => normalizeRecord(record, metadata));
    for (const table of REQUIRED_TABLES.filter(name => !["tariff_codes", "tariff_hierarchy", "data_versions"].includes(name))) {
      dataset[table] = dataset[table].map(record => normalizeMetadata(record, metadata));
    }
    dataset.tariff_hierarchy = buildHierarchy(dataset.tariff_codes);
    const version = normalizeMetadata({
      id: sanitizeText(base.version_id || metadata.sourceVersion, 120).replace(/\s+/g, "-"),
      active: true,
      is_official: metadata.official,
      notice: dataset.notice
    }, metadata);
    dataset.data_versions = [
      version,
      ...dataset.data_versions
        .map(item => ({ ...normalizeMetadata(item, metadata), active: false }))
        .filter(item => item.id !== version.id)
    ];
    return dataset;
  }

  validate(dataset) {
    const errors = [];
    for (const table of REQUIRED_TABLES) {
      if (!Array.isArray(dataset[table])) errors.push(`Tabella ${table} mancante.`);
    }
    const seen = new Set();
    for (const record of dataset.tariff_codes) {
      if (![2, 4, 6, 8, 10].includes(record.code.length)) errors.push(`Lunghezza codice non valida: ${record.code}`);
      if (seen.has(record.code)) errors.push(`Codice duplicato: ${record.code}`);
      seen.add(record.code);
      if (!record.description) errors.push(`Descrizione mancante: ${record.code}`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(record.valid_from || "")) errors.push(`valid_from non valido: ${record.code}`);
    }
    if (!dataset.data_versions.length) errors.push("Versione dati mancante.");
    if (errors.length) throw new Error(`Import doganale non valido:\n- ${errors.slice(0, 30).join("\n- ")}`);
    return true;
  }

  fromCsv(raw, metadata) {
    const rows = parseCsv(raw);
    if (rows.length < 2) throw new Error("CSV vuoto o senza righe dati.");
    const headers = rows[0].map(header => sanitizeText(header, 80).toLowerCase());
    const tariffCodes = rows.slice(1).filter(row => row.some(Boolean)).map(row => {
      const record = Object.fromEntries(headers.map((header, index) => [header, row[index] || ""]));
      return {
        code: record.code,
        level: record.level,
        description: record.description,
        keywords: splitList(record.keywords),
        synonyms: splitList(record.synonyms),
        product_types: splitList(record.product_types),
        materials: splitList(record.materials),
        functions: splitList(record.functions),
        required_attributes: splitList(record.required_attributes),
        source_id: record.source_id || null,
        valid_from: record.valid_from || metadata.validFrom,
        valid_to: record.valid_to || metadata.validTo
      };
    });
    return { schema_version: 1, tariff_codes: tariffCodes };
  }
}

function normalizeRecord(record, metadata) {
  const code = normalizeCode(record.code);
  return normalizeMetadata({
    ...record,
    code,
    level: levelForCode(code),
    description: sanitizeText(record.description, 1000),
    keywords: uniqueStrings(record.keywords, 120),
    synonyms: uniqueStrings(record.synonyms, 120),
    product_types: uniqueStrings(record.product_types, 120),
    materials: uniqueStrings(record.materials, 120),
    functions: uniqueStrings(record.functions, 160),
    required_attributes: uniqueStrings(record.required_attributes, 80),
    excluded_when: uniqueStrings(record.excluded_when, 120)
  }, metadata);
}

function normalizeMetadata(record, metadata) {
  return {
    ...record,
    valid_from: record.valid_from || metadata.validFrom,
    valid_to: record.valid_to ?? metadata.validTo ?? null,
    source: sanitizeText(record.source || metadata.source, 300),
    source_version: sanitizeText(record.source_version || metadata.sourceVersion, 160),
    retrieved_at: record.retrieved_at || metadata.retrievedAt
  };
}

function levelForCode(code) {
  return ({ 2: "CHAPTER", 4: "HS4", 6: "HS6", 8: "CN", 10: "TARIC" })[code.length] || "UNKNOWN";
}

function buildHierarchy(records) {
  const codes = new Set(records.map(record => record.code));
  const hierarchy = [];
  for (const record of records) {
    const lengths = [2, 4, 6, 8, 10].filter(length => length <= record.code.length);
    for (let index = 0; index < lengths.length; index += 1) {
      const code = record.code.slice(0, lengths[index]);
      const parentCode = index ? record.code.slice(0, lengths[index - 1]) : null;
      const key = `${code}:${parentCode || "root"}`;
      if (hierarchy.some(item => item._key === key)) continue;
      hierarchy.push({
        _key: key,
        code,
        parent_code: parentCode,
        level: levelForCode(code),
        explicit_record: codes.has(code),
        valid_from: record.valid_from,
        valid_to: record.valid_to,
        source: record.source,
        source_version: record.source_version,
        retrieved_at: record.retrieved_at
      });
    }
  }
  return hierarchy.map(({ _key, ...item }) => item);
}

function parseCsv(raw) {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (char === '"') {
      if (quoted && raw[index + 1] === '"') { value += '"'; index += 1; }
      else quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(value.trim()); value = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && raw[index + 1] === "\n") index += 1;
      row.push(value.trim());
      if (row.some(Boolean)) rows.push(row);
      row = []; value = "";
    } else value += char;
  }
  row.push(value.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

function splitList(value) {
  return String(value || "").split(/[|;]/).map(item => item.trim()).filter(Boolean);
}

function safeTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

module.exports = {
  CustomsDataImporter,
  buildHierarchy,
  parseCsv,
  levelForCode
};
