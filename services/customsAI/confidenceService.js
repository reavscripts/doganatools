"use strict";

const { boundedNumber, normalizeText, tokenize } = require("./textUtils");

class ConfidenceService {
  scoreCandidate(searchResult, product, context = {}) {
    const record = searchResult.record;
    const components = {
      descriptionMatch: boundedNumber(searchResult.textScore),
      productMatch: listMatch(record.product_types, product.product),
      materialMatch: listMatch(record.materials, product.material),
      functionMatch: listMatch(record.functions, `${product.function || ""} ${product.use || ""}`),
      legalNotes: context.notes?.length ? 0.8 : 0,
      exclusions: exclusionScore(record, product),
      specificity: record.level === "TARIC" && record.code?.length === 10 ? 1 : 0,
      informationCompleteness: completenessScore(record, product, context.answers),
      analogousPrecedents: precedentScore(context.examples, product),
      dataQuality: context.datasetInfo?.isOfficial ? 1 : 0.15,
      aiAdjustment: boundedNumber(context.aiAdjustment || 0, -0.1, 0.1)
    };
    const weighted =
      components.descriptionMatch * 0.44 +
      components.productMatch * 0.12 +
      components.materialMatch * 0.10 +
      components.functionMatch * 0.08 +
      components.legalNotes * 0.03 +
      components.exclusions * 0.03 +
      components.specificity * 0.05 +
      components.informationCompleteness * 0.04 +
      components.analogousPrecedents * 0.03 +
      components.dataQuality * 0.05 +
      components.aiAdjustment * 0.03;
    const uncappedScore = boundedNumber(weighted);
    const score = context.datasetInfo?.isOfficial ? uncappedScore : Math.min(0.69, uncappedScore);
    return {
      score: Number(score.toFixed(4)),
      percentage: Math.round(score * 100),
      reliability: reliabilityLabel(score),
      components,
      uncappedScore: Number(uncappedScore.toFixed(4)),
      legalCertainty: false,
      explanation: "La percentuale esprime l'affidabilità interna del motore sui dati disponibili, non una certezza giuridica."
    };
  }
}

function listMatch(values, text) {
  const wanted = (Array.isArray(values) ? values : []).map(normalizeText).filter(Boolean);
  const actual = normalizeText(text);
  if (!wanted.length) return 0.5;
  if (!actual) return 0.35;
  if (wanted.some(value => actual.includes(value) || value.includes(actual))) return 1;
  const actualTokens = new Set(tokenize(actual));
  const candidateTokens = new Set(tokenize(wanted.join(" ")));
  const matches = Array.from(actualTokens).filter(token => candidateTokens.has(token)).length;
  return matches ? Math.min(0.85, matches / Math.max(1, actualTokens.size)) : 0;
}

function exclusionScore(record, product) {
  const excluded = Array.isArray(record.excluded_when) ? record.excluded_when : [];
  if (!excluded.length) return 1;
  const productText = normalizeText([
    product.product,
    product.material,
    product.function,
    product.use,
    ...(product.additionalCharacteristics || [])
  ].filter(Boolean).join(" "));
  return excluded.some(rule => productText.includes(normalizeText(rule))) ? 0 : 1;
}

function completenessScore(record, product, answers = {}) {
  const required = Array.isArray(record.required_attributes) ? record.required_attributes : [];
  if (!required.length) return 1;
  const aliases = {
    intended_use: "use",
    primary_material: "material",
    main_function: "function"
  };
  const present = required.filter(key => {
    const productKey = aliases[key] || key;
    return Boolean(product[productKey] || answers?.[key]);
  });
  return present.length / required.length;
}

function precedentScore(examples, product) {
  if (!Array.isArray(examples) || !examples.length) return 0;
  const productText = normalizeText([
    product.product,
    product.material,
    product.function,
    product.use
  ].filter(Boolean).join(" "));
  const best = examples.reduce((score, example) => {
    const terms = tokenize([example.product, example.material, example.function, example.use].filter(Boolean).join(" "));
    if (!terms.length) return score;
    const matches = terms.filter(term => productText.includes(term)).length;
    return Math.max(score, matches / terms.length);
  }, 0);
  return boundedNumber(best);
}

function reliabilityLabel(score) {
  if (score >= 0.85) return "ALTA";
  if (score >= 0.6) return "MEDIA";
  return "BASSA";
}

module.exports = { ConfidenceService, reliabilityLabel, listMatch };
