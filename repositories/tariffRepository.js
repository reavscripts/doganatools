"use strict";

const fs = require("fs");
const path = require("path");
const {
  boundedNumber,
  normalizeCode,
  normalizeText,
  tokenizeForSearch
} = require("../services/customsAI/textUtils");
const { expandQuery } = require("../services/customsAI/searchLexicon");

const REQUIRED_TABLES = [
  "tariff_codes",
  "tariff_descriptions",
  "tariff_hierarchy",
  "section_notes",
  "chapter_notes",
  "heading_notes",
  "classification_rules",
  "classification_examples",
  "classification_regulations",
  "bti_examples",
  "taric_measures",
  "data_versions"
];

class TariffRepository {
  constructor(options = {}) {
    this.datasetPath = options.datasetPath || path.join(
      options.rootDir || path.resolve(__dirname, ".."),
      "data",
      "customs",
      "processed",
      "customs-dataset.json"
    );
    this.fs = options.fs || fs;
    this.cache = null;
    this.cacheMtimeMs = null;
    this.codeIndex = null;
    this.searchIndex = null;
    this.hierarchySearchIndex = null;
    this.documentFrequency = null;
  }

  isInstalled() {
    return this.fs.existsSync(this.datasetPath);
  }

  load() {
    if (!this.isInstalled()) return null;
    const stat = this.fs.statSync(this.datasetPath);
    if (this.cache && this.cacheMtimeMs === stat.mtimeMs) return this.cache;
    const parsed = JSON.parse(this.fs.readFileSync(this.datasetPath, "utf8"));
    this.validateDataset(parsed);
    this.cache = parsed;
    this.cacheMtimeMs = stat.mtimeMs;
    this.buildIndexes(parsed);
    return parsed;
  }

  buildIndexes(dataset) {
    this.codeIndex = new Map(dataset.tariff_codes.map(record => [record.code, record]));
    const hierarchyIndex = new Map((dataset.tariff_hierarchy || []).map(record => [record.code, record]));
    for (const [code, record] of hierarchyIndex) {
      if (!this.codeIndex.has(code)) this.codeIndex.set(code, record);
    }
    this.searchIndex = [];
    this.hierarchySearchIndex = (dataset.tariff_hierarchy || [])
      .filter(record => record.level === "HS4" || record.level === "HS6")
      .map(record => {
        const parent = hierarchyIndex.get(record.parent_code);
        return {
          record,
          ownIndex: miniIndex([record.description]),
          pathIndex: miniIndex([parent?.description, record.description])
        };
      });
    this.documentFrequency = new Map();
    for (const record of dataset.tariff_codes) {
      if (record.level !== "TARIC") continue;
      const fields = [
        [record.product_types, 1.45],
        [record.synonyms, 1.35],
        [record.leaf_description, 1.25],
        [record.keywords, 1.1],
        [record.description, 1],
        [record.description_en, 0.72],
        [record.materials, 1.2],
        [record.functions, 1.15],
        [record.category_terms, 0.9]
      ];
      const tokenWeights = new Map();
      const searchableParts = [];
      for (const [value, weight] of fields) {
        const text = Array.isArray(value) ? value.join(" ") : String(value || "");
        if (!text) continue;
        searchableParts.push(text);
        for (const token of tokenizeForSearch(text)) {
          tokenWeights.set(token, Math.max(tokenWeights.get(token) || 0, weight));
        }
      }
      const tokens = Array.from(tokenWeights.keys());
      for (const token of new Set(tokens)) {
        this.documentFrequency.set(token, (this.documentFrequency.get(token) || 0) + 1);
      }
      this.searchIndex.push({
        record,
        tokenWeights,
        tokens,
        normalizedText: normalizeText(searchableParts.join(" ")),
        categoryIndex: miniIndex(record.category_terms || []),
        decisionIndex: miniIndex(String(record.description || "").split("›").slice(3)),
        focusIndex: miniIndex([
          ...(record.product_types || []),
          record.leaf_description
        ])
      });
    }
  }

  validateDataset(dataset) {
    if (!dataset || typeof dataset !== "object" || Array.isArray(dataset)) {
      throw new Error("Dataset doganale non valido: oggetto radice mancante.");
    }
    for (const table of REQUIRED_TABLES) {
      if (!Array.isArray(dataset[table])) {
        throw new Error(`Dataset doganale non valido: tabella ${table} mancante.`);
      }
    }
    for (const record of dataset.tariff_codes) {
      const code = normalizeCode(record?.code);
      if (![2, 4, 6, 8, 10].includes(code.length) || code !== String(record.code)) {
        throw new Error(`Codice doganale non valido nel dataset: ${record?.code ?? "vuoto"}.`);
      }
      for (const field of ["valid_from", "valid_to", "source", "source_version", "retrieved_at"]) {
        if (!(field in record)) {
          throw new Error(`Metadato ${field} mancante per il codice ${code}.`);
        }
      }
    }
    return true;
  }

  getDatasetInfo() {
    const dataset = this.load();
    if (!dataset) {
      return {
        installed: false,
        status: "missing",
        isOfficial: false,
        message: "Il database TARIC non è ancora stato importato."
      };
    }
    const currentVersion = dataset.data_versions.find(item => item.active) || dataset.data_versions[0] || null;
    return {
      installed: true,
      status: dataset.dataset_status || "unknown",
      isOfficial: dataset.dataset_status === "official" && currentVersion?.is_official === true,
      version: currentVersion,
      recordCount: dataset.tariff_codes.length,
      message: dataset.dataset_status === "test"
        ? "Sono installati soltanto dati dimostrativi TEST DATA, non utilizzabili come fonte normativa."
        : null
    };
  }

  getAllTariffCodes() {
    return this.load()?.tariff_codes.slice() || [];
  }

  findByCode(value) {
    const code = normalizeCode(value);
    if (!code) return null;
    this.load();
    return this.codeIndex?.get(code) || null;
  }

  searchTariffCodes(query, options = {}) {
    const exactCode = normalizeCode(query);
    if ([2, 4, 6, 8, 10].includes(exactCode.length) && !/[a-z]/i.test(String(query))) {
      if (exactCode.length === 10) {
        const exact = this.findByCode(exactCode);
        return exact?.level === "TARIC" ? [{ record: exact, textScore: 1, exactCode: true }] : [];
      }
      return this.getAllTariffCodes()
        .filter(record => record.level === "TARIC" && record.code.startsWith(exactCode))
        .slice(0, options.limit || 25)
        .map(record => ({ record, textScore: 1, exactCode: false, exactPrefix: true }));
    }
    this.load();
    const primaryText = [
      query,
      options.product?.product,
      options.product?.material,
      options.product?.function,
      options.product?.use,
      options.product?.composition,
      options.product?.dimensions,
      options.product?.power,
      options.product?.displacement,
      ...(options.product?.semanticTerms || []),
      ...(options.product?.additionalCharacteristics || [])
    ].filter(Boolean).join(" ");
    const facets = extractQueryFacets(primaryText);
    const queryTokens = tokenizeForSearch(stripMeasurements(primaryText));
    const queryTokenSet = new Set(queryTokens);
    const expandedTokens = tokenizeForSearch(expandQuery(primaryText)).filter(token => !queryTokenSet.has(token));
    const date = options.classificationDate || new Date().toISOString().slice(0, 10);
    const requiredPrefix = normalizeCode(options.prefix);
    const candidates = [];
    for (const indexed of this.searchIndex || []) {
      const record = indexed.record;
      if (record.level !== "TARIC" || !this.isValidOn(record, date)) continue;
      if (requiredPrefix && !record.code.startsWith(requiredPrefix)) continue;
      const matchDetails = scoreTokenCoverage(queryTokens, indexed, this.documentFrequency, this.searchIndex.length);
      const expandedCoverage = expandedTokens.length
        ? scoreTokenCoverage(expandedTokens, indexed, this.documentFrequency, this.searchIndex.length).coverage
        : 0;
      const categoryCoverage = scoreMiniIndex(queryTokens, expandedTokens, indexed.categoryIndex);
      const decisionCoverage = scoreMiniIndex(queryTokens, expandedTokens, indexed.decisionIndex, true);
      const focusCoverage = scoreMiniIndex(queryTokens, expandedTokens, indexed.focusIndex, true);
      const phrase = normalizeText(stripMeasurements(query));
      const phraseBonus = phrase && indexed.focusIndex.normalizedText.includes(phrase)
        ? 0.24
        : (phrase && indexed.normalizedText.includes(phrase) ? 0.08 : 0);
      const facetAdjustment = scoreFacets(facets, indexed.normalizedText);
      const baseScore = boundedNumber(
        matchDetails.coverage * 0.52 +
        expandedCoverage * 0.1 +
        categoryCoverage * 0.11 +
        decisionCoverage * 0.22 +
        focusCoverage * 0.09 +
        phraseBonus,
        0,
        1
      );
      const textScore = boundedNumber(baseScore + facetAdjustment, 0, 1);
      if (textScore >= 0.12) {
        candidates.push({
          record,
          textScore,
          matches: matchDetails.matches,
          exactCode: false,
          facetAdjustment
        });
      }
    }
    return candidates
      .sort((a, b) => b.textScore - a.textScore || a.record.code.localeCompare(b.record.code))
      .slice(0, options.limit || 25);
  }

  searchHierarchyBranches(query, options = {}) {
    this.load();
    const level = options.level || "HS4";
    const prefix = String(options.parentPrefix || "");
    const product = options.product || {};
    const canonicalText = [query, product.product, product.function, product.use].filter(Boolean).join(" ");
    const concepts = uniqueConcepts(product.semanticTerms);
    const results = [];
    for (const indexed of this.hierarchySearchIndex || []) {
      const record = indexed.record;
      if (record.level !== level || (prefix && !record.code.startsWith(prefix))) continue;
      const canonicalScore = conceptCoverage(canonicalText, indexed.pathIndex);
      const conceptScores = concepts
        .map(concept => conceptCoverage(concept, indexed.pathIndex))
        .sort((a, b) => b - a);
      const bestConcept = conceptScores[0] || 0;
      const topConcepts = conceptScores.slice(0, 3);
      const averageConcept = topConcepts.length
        ? topConcepts.reduce((sum, value) => sum + value, 0) / topConcepts.length
        : 0;
      const negativeScore = 0;
      const ownSpecificity = concepts.reduce(
        (best, concept) => Math.max(best, conceptCoverage(concept, indexed.ownIndex)),
        0
      );
      const score = boundedNumber(
        canonicalScore * 0.18 +
        bestConcept * 0.42 +
        averageConcept * 0.24 +
        ownSpecificity * 0.16,
        0,
        1
      );
      if (score >= 0.12) {
        results.push({ record, score, canonicalScore, bestConcept, averageConcept, negativeScore, ownSpecificity });
      }
    }
    return results
      .sort((left, right) => right.score - left.score || left.record.code.localeCompare(right.record.code))
      .slice(0, options.limit || 12);
  }

  getHierarchyRecords(level, prefix = "") {
    this.load();
    return (this.hierarchySearchIndex || [])
      .map(item => item.record)
      .filter(record => record.level === level && (!prefix || record.code.startsWith(prefix)));
  }

  semanticSearchTariffCodes() {
    return {
      available: false,
      provider: null,
      results: [],
      message: "Ricerca semantica predisposta ma non configurata."
    };
  }

  isValidOn(record, date) {
    return (!record.valid_from || record.valid_from <= date) && (!record.valid_to || record.valid_to >= date);
  }

  getHierarchyRecord(code) {
    return this.load()?.tariff_hierarchy.find(item => item.code === code) || null;
  }

  getClassificationExamples(code) {
    return (this.load()?.classification_examples || []).filter(item => item.code === code);
  }

  getNotesForCode(code) {
    const dataset = this.load();
    if (!dataset) return [];
    return [
      ...dataset.section_notes,
      ...dataset.chapter_notes,
      ...dataset.heading_notes
    ].filter(item => code.startsWith(item.applies_to || "__none__"));
  }

  getSourceById(sourceId) {
    return this.load()?.sources?.find(item => item.id === sourceId) || null;
  }

  getMeasures(code, date, context = {}) {
    const dataset = this.load();
    if (!dataset) return [];
    const requestedCode = normalizeCode(code).padEnd(10, "0");
    const additionalCode = String(context.additionalCode || "").toUpperCase();
    return (dataset.taric_measures || [])
      .filter(item => (
        measureAppliesToCode(item.code, requestedCode) &&
        this.isValidOn(item, date) &&
        (!item.flow || item.flow === context.flow) &&
        matchesMeasureGeography(item, context, dataset.geographical_areas || []) &&
        (!additionalCode || !item.additional_code || item.additional_code === additionalCode)
      ))
      .map(item => enrichMeasure(item, dataset))
      .sort((left, right) => (
        effectiveCodeLength(right.code) - effectiveCodeLength(left.code) ||
        String(left.measure_type_code || "").localeCompare(String(right.measure_type_code || ""))
      ));
  }
}

function matchesGeography(allowed, actual) {
  if (!Array.isArray(allowed) || !allowed.length || allowed.includes("*")) return true;
  return Boolean(actual && allowed.includes(actual));
}

function measureAppliesToCode(measureCode, requestedCode) {
  const measure = normalizeCode(measureCode).padEnd(10, "0");
  const requested = normalizeCode(requestedCode).padEnd(10, "0");
  if (!measure || !requested) return false;
  return requested.startsWith(measure.slice(0, effectiveCodeLength(measure)));
}

function effectiveCodeLength(value) {
  const code = normalizeCode(value).padEnd(10, "0");
  let length = 10;
  while (length > 2 && code.slice(length - 2, length) === "00") length -= 2;
  return length;
}

function matchesMeasureGeography(measure, context, geographicalAreas) {
  const country = measure.flow === "export"
    ? context.destinationCountry
    : (context.originCountry || context.dispatchCountry);
  if (!country) return true;
  const excluded = new Set([
    ...(measure.excluded_countries || []),
    ...(measure.exclusions || []).map(item => item.country_code || item.iso_code)
  ].filter(Boolean));
  if (excluded.has(country)) return false;
  const direct = measure.flow === "export" ? measure.destination_countries : measure.origin_countries;
  if (Array.isArray(direct) && direct.length) return matchesGeography(direct, country);
  const areaCode = String(measure.geographical_area_code || "").toUpperCase();
  if (!areaCode || areaCode === "*" || areaCode === "1011" || /ALLTC/i.test(areaCode)) return true;
  if (/^[A-Z]{2}$/.test(areaCode)) return areaCode === country;
  const area = geographicalAreas.find(item => String(item.code || item.group_code) === areaCode);
  return Boolean(area && (area.members || []).some(member => (
    String(member.code || member.iso_code || member).toUpperCase() === country &&
    (!member.valid_from || member.valid_from <= context.operationDate) &&
    (!member.valid_to || member.valid_to >= context.operationDate)
  )));
}

function enrichMeasure(measure, dataset) {
  const additional = measure.additional_code
    ? (dataset.additional_codes || []).find(item => item.code === measure.additional_code)
    : null;
  const documentByCode = new Map((dataset.document_codes || []).map(item => [item.code, item]));
  const footnoteByCode = new Map((dataset.footnotes || []).map(item => [item.code, item]));
  return {
    ...measure,
    additional_code_description: additional?.description || measure.additional_code_description || null,
    conditions: (measure.conditions || []).map(condition => ({
      ...condition,
      document: condition.certificate_code ? documentByCode.get(condition.certificate_code) || null : null
    })),
    footnotes: (measure.footnotes || []).map(footnote => (
      typeof footnote === "string"
        ? { code: footnote, description: footnoteByCode.get(footnote)?.description || null }
        : { ...footnote, description: footnote.description || footnoteByCode.get(footnote.code)?.description || null }
    ))
  };
}

function scoreTokenCoverage(queryTokens, indexed, documentFrequency, documentCount) {
  if (!queryTokens.length) return { coverage: 0, matches: [] };
  let matchedWeight = 0;
  let totalWeight = 0;
  const matches = [];
  for (const queryToken of queryTokens) {
    const idf = 1 + Math.log((documentCount + 1) / ((documentFrequency.get(queryToken) || 0) + 1));
    totalWeight += idf;
    let best = null;
    if (indexed.tokenWeights.has(queryToken)) {
      best = {
        token: queryToken,
        score: Math.min(1, (indexed.tokenWeights.get(queryToken) || 1) / 1.25)
      };
    } else {
      for (const recordToken of indexed.tokens) {
        const quality = tokenSimilarity(queryToken, recordToken);
        if (!quality) continue;
        const fieldWeight = Math.min(1, (indexed.tokenWeights.get(recordToken) || 1) / 1.25);
        const score = quality * fieldWeight;
        if (!best || score > best.score) best = { token: recordToken, score };
      }
    }
    if (best) {
      matchedWeight += idf * best.score;
      matches.push(queryToken);
    }
  }
  return {
    coverage: totalWeight ? boundedNumber(matchedWeight / totalWeight) : 0,
    matches
  };
}

function miniIndex(values) {
  const text = (values || []).filter(Boolean).join(" ");
  return {
    tokens: tokenizeForSearch(text),
    length: tokenizeForSearch(text).length,
    normalizedText: normalizeText(text)
  };
}

function scoreMiniIndex(primaryTokens, expandedTokens, index, applyLengthPenalty = false) {
  if (!index?.tokens?.length || !primaryTokens.length) return 0;
  const tokenSet = new Set(index.tokens);
  const primaryMatches = primaryTokens.filter(token => tokenSet.has(token)).length;
  const expandedMatches = expandedTokens.filter(token => tokenSet.has(token)).length;
  let score = primaryMatches / primaryTokens.length;
  if (expandedTokens.length) score = Math.max(score, expandedMatches / expandedTokens.length * 0.8);
  if (applyLengthPenalty && index.length > 24) {
    score *= Math.max(0.62, 1 - Math.log10(index.length / 24) * 0.24);
  }
  return boundedNumber(score);
}

function tokenSimilarity(left, right) {
  if (left === right) return 1;
  if (left.length >= 5 && right.length >= 5 && (left.startsWith(right) || right.startsWith(left))) return 0.86;
  if (left.length < 4 || right.length < 4) return 0;
  const similarity = diceCoefficient(left, right);
  return similarity >= 0.84 ? similarity * 0.82 : 0;
}

function uniqueConcepts(values) {
  return Array.from(new Set((Array.isArray(values) ? values : []).map(normalizeText).filter(Boolean)));
}

function conceptCoverage(value, index) {
  const tokens = tokenizeForSearch(value);
  if (!tokens.length || !index?.tokens?.length) return 0;
  const exact = scoreMiniIndex(tokens, [], index, true);
  const phrase = index.normalizedText.includes(normalizeText(value)) ? 1 : 0;
  return boundedNumber(exact * 0.82 + phrase * 0.18);
}

function diceCoefficient(left, right) {
  if (left === right) return 1;
  const pairs = value => {
    const result = [];
    for (let index = 0; index < value.length - 1; index += 1) result.push(value.slice(index, index + 2));
    return result;
  };
  const rightPairs = pairs(right);
  let intersection = 0;
  for (const pair of pairs(left)) {
    const index = rightPairs.indexOf(pair);
    if (index >= 0) {
      intersection += 1;
      rightPairs.splice(index, 1);
    }
  }
  return (2 * intersection) / Math.max(1, left.length + right.length - 2);
}

function extractQueryFacets(value) {
  const text = String(value || "").toLowerCase().replace(/,/g, ".");
  const facets = {};
  const weight = text.match(/\b(\d+(?:\.\d+)?)\s*(kg|chilogrammi?|g|gr|grammi?)\b/);
  if (weight) {
    const amount = Number(weight[1]);
    const grams = /^kg|^chil/i.test(weight[2]) ? amount * 1000 : amount;
    if (Number.isFinite(grams)) facets.netWeightGrams = grams;
  }
  const power = text.match(/\b(\d+(?:\.\d+)?)\s*(kw|w|cv|hp)\b/);
  if (power) {
    const amount = Number(power[1]);
    const unit = power[2].toLowerCase();
    const powerKw = unit === "w"
      ? amount / 1000
      : (unit === "cv" ? amount * 0.73549875 : (unit === "hp" ? amount * 0.745699872 : amount));
    if (Number.isFinite(powerKw)) facets.powerKw = powerKw;
  }
  return facets;
}

function stripMeasurements(value) {
  return String(value || "")
    .replace(/\b\d+(?:[.,]\d+)?\s*(?:kg|chilogrammi?|g|gr|grammi?)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function scoreFacets(facets, normalizedText) {
  let adjustment = 0;
  if (Number.isFinite(facets.netWeightGrams)) {
    const upToOneKg = /inferiore o uguale a 1 kg|non exceeding 1 kg|not exceeding 1 kg/.test(normalizedText);
    const overOneKg = !upToOneKg && /superiore a 1 kg|(?<!not )exceeding 1 kg/.test(normalizedText);
    if (facets.netWeightGrams > 1000) {
      if (overOneKg) adjustment += 0.16;
      if (upToOneKg) adjustment -= 0.28;
    } else {
      if (upToOneKg) adjustment += 0.16;
      if (overOneKg) adjustment -= 0.28;
    }
  }
  if (Number.isFinite(facets.powerKw)) {
    adjustment += scoreNumericRange(facets.powerKw, normalizedText, "kw");
  }
  return boundedNumber(adjustment, -0.45, 0.28);
}

function scoreNumericRange(value, text, unit) {
  const escapedUnit = unit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const upperPattern = new RegExp(`(?:inferiore o uguale a|non superiore a|not exceeding)\\s*(\\d+(?:[.,]\\d+)?)\\s*${escapedUnit}`, "i");
  const lowerPattern = new RegExp(`(?:superiore a|exceeding)\\s*(\\d+(?:[.,]\\d+)?)\\s*${escapedUnit}`, "i");
  const upper = text.match(upperPattern);
  const lower = text.match(lowerPattern);
  if (!upper && !lower) return 0;
  const upperValue = upper ? Number(upper[1].replace(",", ".")) : Infinity;
  const lowerValue = lower ? Number(lower[1].replace(",", ".")) : -Infinity;
  const matches = value > lowerValue && value <= upperValue;
  return matches ? 0.2 : -0.34;
}

module.exports = {
  TariffRepository,
  REQUIRED_TABLES,
  matchesGeography,
  measureAppliesToCode,
  matchesMeasureGeography,
  scoreTokenCoverage,
  tokenSimilarity,
  extractQueryFacets,
  stripMeasurements,
  scoreFacets
};
