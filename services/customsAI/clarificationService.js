"use strict";

const { normalizeText, sanitizeText, uniqueStrings } = require("./textUtils");

class ClarificationService {
  constructor(options = {}) {
    this.repository = options.repository;
  }

  build(options = {}) {
    const input = options.input || {};
    const product = options.product || {};
    const classification = options.classification || {};
    const answers = input.answers || {};
    const evidence = collectEvidence(input.description, answers, product);
    const records = this.collectDecisionRecords(
      classification.code,
      options.candidates,
      input.classificationDate
    );
    const cleanCode = String(classification.code || "").replace(/\D/g, "");
    const tightPrefix = cleanCode.length < 10 ? cleanCode : cleanCode.slice(0, 6);
    const tightRecords = records.filter(record => record.code.startsWith(tightPrefix));
    const generated = [
      buildPowerQuestion(tightRecords, evidence, product),
      buildNetWeightQuestion(tightRecords, evidence),
      buildDisplacementQuestion(tightRecords, evidence, product),
      buildMaterialQuestion(records, options.candidates, evidence, product),
      ...buildStateQuestions(tightRecords, evidence),
      buildEggQuestion(tightRecords, evidence),
      buildCompositionQuestion(tightRecords, evidence, product)
    ].filter(Boolean);
    const semantic = semanticQuestions(options.semanticDetails, tightRecords, evidence, product);
    const legacy = Array.isArray(options.legacyQuestions) ? options.legacyQuestions : [];
    const allQuestions = dedupeQuestions([...generated, ...legacy, ...semantic]);
    const unresolvedAnswers = allQuestions
      .filter(questionValue => hasAnswer(questionValue, answers) && isUnknownAnswer(answers[questionValue.id]))
      .map(questionValue => ({
        id: questionValue.id,
        text: sanitizeText(questionValue.text, 280),
        value: sanitizeText(answers[questionValue.id], 100)
      }));
    const questions = allQuestions
      .filter(questionValue => !hasAnswer(questionValue, answers))
      .sort((left, right) => (right.priority || 0) - (left.priority || 0))
      .slice(0, 4)
      .map(publicQuestion);

    if (!questions.length && !unresolvedAnswers.length && String(classification.code || "").length < 10) {
      questions.push(publicQuestion({
        id: "technical_details",
        topic: "technical_details",
        text: "Quali sono composizione, uso preciso e caratteristiche tecniche del prodotto?",
        reason: "Il ramo merceologico è chiaro, ma questi dati servono per distinguere le sottovoci CN/TARIC.",
        placeholder: "Scrivi i dettagli presenti in scheda tecnica o fattura",
        options: [],
        required: true,
        priority: 10
      }));
    }

    const activeQuestion = questions[0] || null;
    return {
      needed: Boolean(activeQuestion || unresolvedAnswers.length),
      activeQuestion,
      questions,
      remainingCount: questions.length,
      unresolvedAnswers,
      answeredDetails: Object.entries(answers).map(([id, value]) => ({
        id,
        value: sanitizeText(value, 180)
      }))
    };
  }

  collectDecisionRecords(code, rankedCandidates = [], classificationDate) {
    const records = [];
    const seen = new Set();
    const add = record => {
      if (!record?.code || seen.has(record.code)) return;
      if (classificationDate && !this.repository.isValidOn(record, classificationDate)) return;
      seen.add(record.code);
      records.push(record);
    };
    for (const candidate of Array.isArray(rankedCandidates) ? rankedCandidates.slice(0, 14) : []) {
      add(candidate.record || candidate);
    }
    const cleanCode = String(code || "").replace(/\D/g, "");
    const prefix = cleanCode.length < 10 ? cleanCode : cleanCode.slice(0, 6);
    if (prefix) {
      for (const record of this.repository.getAllTariffCodes()) {
        if (records.length >= 220) break;
        if (record.level === "TARIC" && record.code.startsWith(prefix)) add(record);
      }
    }
    return records;
  }
}

function buildNetWeightQuestion(records, evidence) {
  if (hasWeight(evidence)) return null;
  const descriptions = descriptionsOf(records);
  const relevant = descriptions.filter(value => (
    /(?:contenuto|peso)\s+netto/i.test(value) && /(?:kg|chilogram|gramm)/i.test(value)
  ));
  if (relevant.length < 2) return null;
  const thresholds = extractThresholds(relevant.join(" "), ["kg", "g"]);
  if (!thresholds.length) return null;
  const options = rangeOptions(thresholds, thresholds.some(item => item.unit === "kg") ? "kg" : "g");
  return question({
    id: "net_weight",
    topic: "weight",
    text: "Qual è il peso netto di una singola confezione?",
    reason: "Nel ramo individuato esistono sottovoci separate in base al contenuto netto dell'imballaggio.",
    placeholder: "Es. 600 g oppure 2 kg",
    options,
    priority: 96
  });
}

function buildPowerQuestion(records, evidence, product) {
  if (product.power || hasPower(evidence)) return null;
  const relevant = descriptionsOf(records).filter(value => /\bpotenza\b/i.test(value) && /\bkW\b/i.test(value));
  if (relevant.length < 2) return null;
  const thresholds = extractThresholds(relevant.join(" "), ["kw"]);
  return question({
    id: "power",
    topic: "power",
    text: "Qual è la potenza nominale in kW?",
    reason: "Le sottovoci disponibili cambiano in base alla fascia di potenza.",
    placeholder: "Es. 110 kW",
    options: rangeOptions(thresholds, "kW"),
    priority: 100
  });
}

function buildDisplacementQuestion(records, evidence, product) {
  if (product.displacement || hasDisplacement(evidence)) return null;
  const relevant = descriptionsOf(records).filter(value => /cilindrata/i.test(value) && /(?:cm\$?3|cm³|cc)/i.test(value));
  if (relevant.length < 2) return null;
  return question({
    id: "displacement",
    topic: "displacement",
    text: "Qual è la cilindrata del motore?",
    reason: "La cilindrata compare tra i criteri ufficiali del ramo individuato.",
    placeholder: "Es. 1 998 cm³ oppure 2.0 L",
    options: [],
    priority: 78
  });
}

function buildMaterialQuestion(records, rankedCandidates, evidence, product) {
  if (product.material || hasKnownMaterial(evidence)) return null;
  const candidateRecords = (Array.isArray(rankedCandidates) ? rankedCandidates : [])
    .slice(0, 10)
    .map(candidate => candidate.record || candidate);
  const materials = uniqueStrings(
    [...candidateRecords, ...records.slice(0, 30)].flatMap(record => record?.materials || []),
    80
  ).filter(value => value.length > 2);
  const broadMaterials = collapseMaterials(materials);
  if (broadMaterials.length < 2) return null;
  return question({
    id: "material",
    topic: "material",
    text: "Qual è il materiale o componente principale?",
    reason: "I candidati più vicini appartengono a famiglie separate dal materiale prevalente.",
    placeholder: "Es. acciaio inox, plastica, cotone 80%",
    options: broadMaterials.slice(0, 6).map(titleCase).concat("Altro"),
    priority: 90
  });
}

function buildStateQuestions(records, evidence) {
  const descriptions = descriptionsOf(records);
  const rules = [
    {
      id: "preservation_method",
      topic: "preservation",
      text: "Come è preparato o conservato il prodotto?",
      reason: "Il metodo di preparazione o conservazione separa le voci candidate.",
      placeholder: "Es. al naturale, sott'aceto, in salamoia",
      options: [
        ["Con aceto o acido acetico", /(?:\bcon aceto\b|(?<!non )nell['’]?aceto)/i],
        ["Senza aceto o acido acetico", /(?:non nell['’]?aceto|senza aceto|senza acido acetico)/i]
      ],
      priority: 94
    },
    {
      id: "product_state",
      topic: "cooking_state",
      text: "In quale stato viene venduto il prodotto?",
      reason: "Prodotto non cotto, cotto o farcito può seguire sottovoci diverse.",
      placeholder: "Es. non cotto e non farcito",
      options: [
        ["Non cotto e non farcito", /non cott[aei].*n[eé] farcit|non cotta né farcita/i],
        ["Farcito", /farcit[oaie]/i],
        ["Cotto", /\bcott[oaie]\b/i]
      ],
      priority: 88
    },
    {
      id: "physical_state",
      topic: "physical_state",
      text: "Qual è lo stato fisico o di conservazione al momento dell'importazione?",
      reason: "Fresco, refrigerato, congelato o secco può cambiare la classificazione.",
      placeholder: "Es. congelato",
      options: [
        ["Fresco", /\bfresc[oaie]\b/i],
        ["Refrigerato", /refrigerat[oaie]/i],
        ["Congelato", /congelat[oaie]/i],
        ["Secco", /\bsecc[oaheti]*\b/i]
      ],
      priority: 84
    },
    {
      id: "product_form",
      topic: "form",
      text: "In quale forma si presenta il prodotto?",
      reason: "La forma commerciale distingue le sottovoci presenti nel ramo.",
      placeholder: "Es. intero, in pezzi, polpa o concentrato",
      options: [
        ["Intero o in pezzi", /inter[io] o in pezzi/i],
        ["Polpa / purea / passata", /\b(polpa|purea|passata)\b/i],
        ["Concentrato", /concentrat[oaie]/i]
      ],
      priority: 80
    },
    {
      id: "retail_packaging",
      topic: "packaging",
      text: "È confezionato per la vendita al minuto?",
      reason: "Il confezionamento al dettaglio distingue alcune sottovoci.",
      placeholder: "Sì, no oppure descrivi l'imballaggio",
      options: [
        ["Sì, vendita al minuto", /(?<!non )condizionat[oaie].{0,35}vendita al minuto/i],
        ["No, non al minuto", /non condizionat[oaie].{0,35}vendita al minuto/i]
      ],
      priority: 70
    }
  ];
  return rules.map(rule => {
    const available = rule.options.filter(([, pattern]) => descriptions.some(value => pattern.test(value)));
    const distinct = new Set(available.map(([label]) => label));
    if (distinct.size < 2 || rule.options.some(([, pattern]) => pattern.test(evidence))) return null;
    return question({
      ...rule,
      options: available.map(([label]) => label)
    });
  }).filter(Boolean);
}

function buildEggQuestion(records, evidence) {
  if (/\buov[oa]\b/i.test(evidence)) return null;
  const descriptions = descriptionsOf(records);
  const withEgg = descriptions.some(value => /contenenti uova/i.test(value));
  const withoutEgg = descriptions.some(value => /(?:altre|altri|non contenenti uova)/i.test(value));
  if (!withEgg || !withoutEgg) return null;
  return question({
    id: "contains_egg",
    topic: "egg",
    text: "Il prodotto contiene uova?",
    reason: "La presenza di uova separa le sottovoci candidate.",
    placeholder: "Sì, no o non noto",
    options: ["Sì", "No", "Non noto"],
    priority: 76
  });
}

function buildCompositionQuestion(records, evidence, product) {
  if (product.composition || /\b\d{1,3}(?:[.,]\d+)?\s*%/i.test(evidence)) return null;
  const descriptions = descriptionsOf(records);
  const percentageRecords = descriptions.filter(value => /\b\d{1,3}(?:[.,]\d+)?\s*%/i.test(value));
  if (percentageRecords.length < 2) return null;
  return question({
    id: "composition",
    topic: "composition",
    text: "Quali sono gli ingredienti o materiali principali e le relative percentuali?",
    reason: "Nel ramo individuato alcune soglie percentuali cambiano la sottovoce.",
    placeholder: "Es. amido 20%, latte 8%, proteine 16%",
    options: [],
    priority: 64
  });
}

function semanticQuestions(details, records, evidence, product) {
  return (Array.isArray(details) ? details : [])
    .filter(detail => (
      supportsSemanticDetail(detail, records) &&
      !semanticTopicResolved(inferTopic(detail), evidence, product)
    ))
    .slice(0, 3)
    .map((detail, index) => ({
    id: `semantic_detail_${index + 1}`,
    topic: inferTopic(detail),
    text: `Puoi indicare ${String(detail).replace(/[?.]+$/, "").toLowerCase()}?`,
    reason: "Questo dato può cambiare la sottovoce CN/TARIC.",
    placeholder: "Scrivi il dettaglio disponibile",
    required: true,
    options: [],
    priority: 58 - index
    }));
}

function semanticTopicResolved(topic, evidence, product) {
  if (topic === "weight") return hasWeight(evidence);
  if (topic === "power") return Boolean(product?.power || hasPower(evidence));
  if (topic === "displacement") return Boolean(product?.displacement || hasDisplacement(evidence));
  if (topic === "material") return Boolean(product?.material || hasKnownMaterial(evidence));
  if (topic === "composition") return Boolean(product?.composition || /\b\d{1,3}(?:[.,]\d+)?\s*%/i.test(evidence));
  if (topic === "cooking_state") return /\b(?:cott[oaie]|farcit[oaie])\b/i.test(evidence);
  if (topic === "use") return /\b(?:auto|autoveicol[io]|veicol[io]|trattor[ei]|nav[ei]|aeromobil[ei]|industriale|domestico)\b/i.test(evidence);
  return false;
}

function supportsSemanticDetail(detail, records) {
  const topic = inferTopic(detail);
  const officialText = normalizeText(descriptionsOf(records).join(" "));
  if (!officialText) return false;
  if (topic === "weight") return /(?:peso|contenuto netto|kg|gramm)/.test(officialText);
  if (topic === "power") return /(?:potenza|kw|watt)/.test(officialText);
  if (topic === "displacement") return /(?:cilindrat|cm3|cc)/.test(officialText);
  if (topic === "composition") return /(?:contenent|tenore|percent|composizion)/.test(officialText);
  if (topic === "material") {
    return uniqueStrings((records || []).flatMap(record => record?.materials || []), 80).length >= 2;
  }
  if (topic === "use") return /(?:destinat|utilizzat|impiego|uso)/.test(officialText);
  const ignored = new Set(["specificare", "indicare", "prodotto", "merce", "eventuale", "preciso", "principale"]);
  const terms = normalizeText(detail).split(" ").filter(term => term.length >= 5 && !ignored.has(term));
  return terms.some(term => officialText.includes(term));
}

function question(value) {
  return {
    required: value.required !== false,
    ...value,
    options: (value.options || []).map(option => (
      option && typeof option === "object"
        ? { label: String(option.label), value: String(option.value) }
        : { label: String(option), value: String(option) }
    ))
  };
}

function publicQuestion(value) {
  return {
    id: sanitizeText(value.id, 80),
    topic: sanitizeText(value.topic || inferTopic(value.text), 80),
    text: sanitizeText(value.text, 280),
    reason: sanitizeText(value.reason, 320),
    placeholder: sanitizeText(value.placeholder || "Scrivi la risposta", 160),
    required: value.required !== false,
    options: (value.options || []).slice(0, 7).map(option => (
      typeof option === "string"
        ? { label: sanitizeText(option, 100), value: sanitizeText(option, 100) }
        : { label: sanitizeText(option.label, 100), value: sanitizeText(option.value, 100) }
    ))
  };
}

function dedupeQuestions(questions) {
  const result = [];
  const seenIds = new Set();
  const seenTopics = new Set();
  for (const raw of questions) {
    if (!raw?.id || !raw?.text) continue;
    const current = {
      ...raw,
      topic: raw.topic || inferTopic(raw.text),
      priority: Number(raw.priority || 40)
    };
    if (seenIds.has(current.id) || seenTopics.has(current.topic)) continue;
    seenIds.add(current.id);
    seenTopics.add(current.topic);
    result.push(current);
  }
  return result;
}

function hasAnswer(questionValue, answers) {
  return Object.prototype.hasOwnProperty.call(answers || {}, questionValue.id) && sanitizeText(answers[questionValue.id], 500).length > 0;
}

function isUnknownAnswer(value) {
  return /^(?:non\s+(?:so|noto|nota|disponibile)|sconosciut[oa]|n\/a)$/i.test(sanitizeText(value, 100));
}

function collectEvidence(description, answers, product) {
  return [
    description,
    ...Object.values(answers || {}),
    product.material,
    product.composition,
    product.dimensions,
    product.power,
    product.displacement,
    ...(product.additionalCharacteristics || [])
  ].filter(Boolean).join(" ");
}

function descriptionsOf(records) {
  return (records || []).map(record => {
    const parts = String(record?.description || "").split("›").map(value => value.trim()).filter(Boolean);
    return (parts.length > 2 ? parts.slice(2) : parts).join(" › ");
  }).filter(Boolean);
}

function extractThresholds(text, units) {
  const unitPattern = units.map(unit => unit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const regex = new RegExp(`\\b(\\d+(?:[.,]\\d+)?)\\s*(${unitPattern})\\b`, "gi");
  const result = [];
  let match;
  while ((match = regex.exec(text))) {
    const value = Number(match[1].replace(",", "."));
    if (!Number.isFinite(value)) continue;
    const unit = match[2].toLowerCase();
    if (!result.some(item => item.value === value && item.unit === unit)) result.push({ value, unit });
  }
  return result.sort((left, right) => left.value - right.value).slice(0, 5);
}

function rangeOptions(thresholds, displayUnit) {
  const values = uniqueStrings((thresholds || []).map(item => String(item.value)), 20)
    .map(Number)
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  if (!values.length || values.length > 4) return [];
  const format = value => Number.isInteger(value) ? String(value) : String(value).replace(".", ",");
  const result = [{
    label: `Fino a ${format(values[0])} ${displayUnit}`,
    value: `${format(values[0])} ${displayUnit} (fino a ${format(values[0])} ${displayUnit})`
  }];
  for (let index = 1; index < values.length; index += 1) {
    result.push({
      label: `Oltre ${format(values[index - 1])} fino a ${format(values[index])} ${displayUnit}`,
      value: `${format(values[index])} ${displayUnit} (oltre ${format(values[index - 1])} fino a ${format(values[index])} ${displayUnit})`
    });
  }
  const last = values[values.length - 1];
  const above = last + (last < 10 ? 1 : Math.max(1, Math.round(last * 0.01)));
  result.push({
    label: `Oltre ${format(last)} ${displayUnit}`,
    value: `${format(above)} ${displayUnit} (oltre ${format(last)} ${displayUnit})`
  });
  return result;
}

function collapseMaterials(materials) {
  return uniqueStrings(materials, 80);
}

function inferTopic(value) {
  const text = normalizeText(value);
  if (/peso|gramm|chilogram|kg/.test(text)) return "weight";
  if (/potenza|kw|watt/.test(text)) return "power";
  if (/cilindrat|cm3|cc/.test(text)) return "displacement";
  if (/material|fibra|componente principal/.test(text)) return "material";
  if (/composizion|percentual|ingredien/.test(text)) return "composition";
  if (/uso|destinazion|impiego|tipo.*veicolo|installazion/.test(text)) return "use";
  if (/cott|farcit/.test(text)) return "cooking_state";
  return normalizeText(value).split(" ").slice(0, 5).join("_") || "detail";
}

function hasWeight(value) {
  return /\b\d+(?:[.,]\d+)?\s*(?:kg|chilogrammi?|g|gr|grammi?)\b/i.test(value);
}

function hasPower(value) {
  return /\b\d+(?:[.,]\d+)?\s*(?:kw|w|cv|hp)\b/i.test(value);
}

function hasDisplacement(value) {
  return /\b\d+(?:[.,]\d+)?\s*(?:cm\s*[³3]|cc|cmc|litri?|l)\b/i.test(value);
}

function hasKnownMaterial(value) {
  return /\b(?:acciaio|inox|alluminio|bambu|bambù|cotone|legno|plastica|silicone|vetro|lana|pelle|cuoio|gomma|ceramica|marmo|rame|ottone)\b/i.test(value);
}

function titleCase(value) {
  return String(value || "").replace(/(^|\s)\p{L}/gu, match => match.toLocaleUpperCase("it-IT"));
}

module.exports = {
  ClarificationService,
  buildNetWeightQuestion,
  buildPowerQuestion,
  buildMaterialQuestion,
  rangeOptions,
  inferTopic
};
