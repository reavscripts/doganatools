"use strict";

const { sanitizeText, normalizeText, tokenize, stemSearchToken } = require("./textUtils");

class ClassificationEngine {
  constructor(options) {
    Object.assign(this, options);
  }

  async classify(input) {
    const knowledgeAnswer = Object.keys(input.answers || {}).length === 0
      ? this.knowledgeService?.answer(input.description)
      : null;
    if (knowledgeAnswer) {
      const response = {
        module: "DOGANA AI",
        moduleVersion: this.moduleVersion,
        classificationDate: input.classificationDate,
        originalDescription: input.description,
        status: "answered",
        dataset: this.repository.getDatasetInfo(),
        ai: this.aiProvider?.getStatus?.() || null,
        answer: knowledgeAnswer,
        message: "Domanda doganale riconosciuta."
      };
      this.writeHistory(input, response, []);
      return response;
    }

    const analysis = await this.productAnalyzer.analyze(input.description, input.answers);
    const datasetInfo = this.repository.getDatasetInfo();
    const base = {
      module: "DOGANA AI",
      moduleVersion: this.moduleVersion,
      classificationDate: input.classificationDate,
      originalDescription: input.description,
      product: analysis.product,
      ai: analysis.ai
    };

    if (!datasetInfo.installed) {
      const response = {
        ...base,
        status: "dataset_missing",
        dataset: datasetInfo,
        missingDetails: analysis.questions,
        message: "Il database TARIC non è ancora stato importato. Il motore può analizzare la merce ma non può fornire una classificazione normativa verificata."
      };
      this.writeHistory(input, response, []);
      return response;
    }

    const semanticBranch = await findSemanticBranch(
      this.repository,
      this.aiProvider,
      input.description,
      analysis.product
    );
    const candidates = await this.rankCandidates(
      input,
      analysis.product,
      datasetInfo,
      semanticBranch?.record?.code || null
    );
    const topCandidate = candidates[0] || null;
    if (semanticBranch && shouldReturnBranch(semanticBranch, topCandidate, input.description, analysis.product)) {
      const response = this.buildBranchResponse(input, analysis, datasetInfo, base, semanticBranch, candidates);
      this.writeHistory(input, response, candidates);
      return response;
    }
    if (!candidates.length) {
      const response = {
        ...base,
        status: "no_candidates",
        dataset: datasetInfo,
        candidates: [],
        message: "Questo prodotto non è ancora coperto dai dati locali. Prova con una descrizione più comune o importa la nomenclatura completa."
      };
      this.writeHistory(input, response, []);
      return response;
    }

    const top = candidates[0];
    if (!top || top.confidence.score < 0.32) {
      const response = {
        ...base,
        status: "no_candidates",
        dataset: datasetInfo,
        candidates: attachRelativePercentages(selectComparableCandidates(candidates)).map(candidateSummary),
        message: "Le corrispondenze trovate sono troppo deboli per proporre un codice."
      };
      this.writeHistory(input, response, candidates);
      return response;
    }

    const validation = this.classificationValidator.validate(top, datasetInfo);
    if (!validation.valid) {
      const response = {
        ...base,
        status: "validation_error",
        dataset: datasetInfo,
        errors: validation.errors,
        warnings: validation.warnings,
        message: "Il candidato non ha superato la validazione gerarchica. Non viene proposto alcun codice."
      };
      this.writeHistory(input, response, candidates);
      return response;
    }

    const sourceResult = this.sourceService.getSources(top.record, datasetInfo);
    const reasons = buildReasons(analysis.product, top, validation, datasetInfo);
    const clarification = this.clarificationService.build({
      input,
      product: analysis.product,
      classification: { code: top.record.code, level: "TARIC" },
      candidates,
      legacyQuestions: analysis.questions,
      semanticDetails: analysis.product.decisiveDetails
    });
    const assumptions = buildAssumptions(clarification.questions, top.record);
    const comparableCandidates = attachRelativePercentages(selectComparableCandidates(candidates));
    const relativeByCode = new Map(comparableCandidates.map(candidate => [candidate.record.code, candidate.relativePercentage]));
    const classification = {
      code: top.record.code,
      level: "TARIC",
      description: top.record.description,
      officialDescription: datasetInfo.isOfficial ? top.record.description : null,
      hierarchy: validation.hierarchy,
      confidence: top.confidence,
      relativePercentage: relativeByCode.get(top.record.code) ?? 100,
      reasons,
      assumptions,
      resultNotes: Array.isArray(top.record.result_notes) ? top.record.result_notes : [],
      decisionStatus: clarification.needed ? "provisional" : "complete",
      completeTaric: !clarification.needed,
      nextQuestion: clarification.activeQuestion?.text || null,
      normativeVerified: validation.normativeVerified && sourceResult.normativeVerified,
      validFrom: top.record.valid_from,
      validTo: top.record.valid_to,
      dataVersion: datasetInfo.version || null
    };
    const alternatives = comparableCandidates
      .filter(candidate => candidate.record.code !== top.record.code)
      .map(candidate => ({
      ...candidateSummary(candidate),
      differenceReason: alternativeReason(candidate, top, analysis.product)
      }));
    const response = {
      ...base,
      status: "classified",
      title: productTitle(analysis.product),
      dataset: datasetInfo,
      classification,
      alternatives,
      missingDetails: clarification.questions,
      clarification,
      provisional: clarification.needed || !classification.normativeVerified,
      percentageType: "relative_compatibility",
      sources: sourceResult.available,
      unavailableSources: sourceResult.unavailable,
      warnings: [...validation.warnings, ...(analysis.ai.warning ? [analysis.ai.warning] : [])],
      message: clarification.needed
        ? "Ho individuato il miglior candidato attuale. Rispondi al dettaglio richiesto per verificare la sottovoce esatta."
        : "Risultato immediato basato sui dati disponibili.",
      disclaimer: "La classificazione proposta costituisce uno strumento di supporto operativo e non sostituisce un'Informazione Tariffaria Vincolante (ITV/BTI) o la valutazione dell'autorità doganale competente."
    };
    this.writeHistory(input, response, candidates);
    return response;
  }

  buildBranchResponse(input, analysis, datasetInfo, base, branch, candidates = []) {
    const branchRecord = branch.record;
    const branchCode = branchRecord.code;
    const hs4Record = this.repository.findByCode(branchCode.slice(0, 4));
    const chapterRecord = this.repository.findByCode(branchCode.slice(0, 2));
    const sourceRecord = this.repository.getAllTariffCodes().find(record => record.code.startsWith(branchCode));
    const sourceResult = this.sourceService.getSources(sourceRecord, datasetInfo);
    const description = [
      branchCode.length > 4 ? hs4Record?.description : null,
      branchRecord?.description
    ]
      .filter(Boolean)
      .join(" › ");
    const confidenceScore = Math.min(0.94, Math.max(0.58, 0.58 + branch.score * 0.36));
    const confidence = {
      score: Number(confidenceScore.toFixed(4)),
      percentage: Math.round(confidenceScore * 100),
      reliability: confidenceScore >= 0.85 ? "ALTA" : "MEDIA",
      legalCertainty: false,
      explanation: "La percentuale riguarda la compatibilità con il ramo HS/CN individuato; non indica che la TARIC a 10 cifre sia già determinata."
    };
    const classification = {
      code: branchCode,
      level: branchRecord.level,
      description,
      officialDescription: datasetInfo.isOfficial ? description : null,
      hierarchy: {
        chapter: hierarchyItem(chapterRecord, branchCode.slice(0, 2), "HS", "Capitolo HS"),
        hs4: hierarchyItem(hs4Record, branchCode.slice(0, 4), "HS4", "Voce HS"),
        ...(branchCode.length >= 6
          ? { hs6: hierarchyItem(branchRecord, branchCode.slice(0, 6), "HS6", "Sottovoce HS") }
          : {})
      },
      confidence,
      relativePercentage: 100,
      reasons: [
        `Il bene è stato interpretato come ${analysis.product.product || "prodotto non specificato"}.`,
        "Il significato commerciale è stato confrontato prima con le famiglie HS/CN ufficiali, separando prodotto, destinatario, uso e macchine collegate.",
        `Il ramo ${formatCodeForText(branchCode)} è quello semanticamente più coerente tra le descrizioni presenti nel database.`,
        ...(branch.selectionReason ? [branch.selectionReason] : [])
      ],
      assumptions: [],
      resultNotes: [],
      needsDetails: [],
      nextQuestion: null,
      decisionStatus: "branch",
      completeTaric: false,
      normativeVerified: datasetInfo.isOfficial && sourceResult.normativeVerified,
      validFrom: branchRecord.valid_from || null,
      validTo: branchRecord.valid_to || null,
      dataVersion: datasetInfo.version || null
    };
    const clarification = this.clarificationService.build({
      input,
      product: analysis.product,
      classification,
      candidates,
      legacyQuestions: analysis.questions,
      semanticDetails: analysis.product.decisiveDetails
    });
    const missingDetails = clarification.questions;
    classification.needsDetails = missingDetails;
    classification.nextQuestion = clarification.activeQuestion?.text || buildNextQuestion(analysis.product.decisiveDetails);
    return {
      ...base,
      status: "classified",
      title: productTitle(analysis.product),
      dataset: datasetInfo,
      classification,
      alternatives: branchAlternatives(branch),
      missingDetails,
      clarification,
      provisional: true,
      percentageType: "branch_compatibility",
      sources: sourceResult.available,
      unavailableSources: sourceResult.unavailable,
      warnings: analysis.ai.warning ? [analysis.ai.warning] : [],
      message: "Famiglia HS/CN individuata. Mancano ancora dati decisivi per proporre responsabilmente una TARIC a 10 cifre.",
      disclaimer: "La classificazione proposta costituisce uno strumento di supporto operativo e non sostituisce un'Informazione Tariffaria Vincolante (ITV/BTI) o la valutazione dell'autorità doganale competente."
    };
  }

  async rankCandidates(input, product, datasetInfo, preferredPrefix = null) {
    let searchResults = this.tariffSearchService.searchTariffCodes(
      input.description,
      product,
      { classificationDate: input.classificationDate, limit: 25 }
    );
    if (preferredPrefix) {
      const preferredResults = searchResults.filter(result => result.record.code.startsWith(preferredPrefix));
      searchResults = preferredResults.length
        ? preferredResults
        : this.tariffSearchService.searchTariffCodes(
          input.description,
          product,
          { classificationDate: input.classificationDate, limit: 25, prefix: preferredPrefix }
        );
    }
    if (!searchResults.length) return [];
    // La TARIC resta deterministica: l'AI interviene solo come spareggio HS.
    const aiAdjustments = new Map();
    return searchResults.map(searchResult => {
      const record = searchResult.record;
      const examples = this.repository.getClassificationExamples(record.code);
      const notes = this.repository.getNotesForCode(record.code);
      const aiRanking = aiAdjustments.get(record.code);
      const confidence = this.confidenceService.scoreCandidate(searchResult, product, {
        datasetInfo,
        examples,
        notes,
        answers: input.answers,
        aiAdjustment: aiRanking?.adjustment || 0
      });
      return {
        record,
        searchResult,
        confidence,
        notes,
        examples,
        aiReasons: aiRanking?.reasons || []
      };
    }).sort((a, b) => b.confidence.score - a.confidence.score || a.record.code.localeCompare(b.record.code));
  }

  async getAIAdjustments(product, searchResults) {
    const result = new Map();
    if (!this.aiProvider?.available) return result;
    try {
      const rankings = await this.aiProvider.rankCandidates(product, searchResults.map(item => ({
        code: item.record.code,
        description: item.record.description,
        materials: item.record.materials,
        functions: item.record.functions
      })));
      for (const item of rankings || []) result.set(item.code, item);
    } catch {}
    return result;
  }

  writeHistory(input, response, candidates) {
    try {
      response.historyTimestamp = this.historyService.append({
        description: input.description,
        product: response.product,
        questions: response.questions || [],
        answers: input.answers,
        candidates: candidates.map(candidate => candidateSummary(candidate)),
        result: response.classification || null,
        status: response.status,
        confidence: response.classification?.confidence || null,
        nomenclatureVersion: response.dataset?.version || null,
        sources: response.sources || []
      });
    } catch (error) {
      response.historyWarning = `Storico non disponibile: ${sanitizeText(error.message, 160)}`;
    }
  }
}

async function findSemanticBranch(repository, aiProvider, query, product) {
  if (!Array.isArray(product?.semanticTerms) || product.semanticTerms.length < 2) return null;
  const hs4Results = repository.searchHierarchyBranches(query, {
    product,
    level: "HS4",
    limit: 12
  });
  const candidateMap = new Map();
  const addRecord = record => {
    if (record?.level === "HS4" && !candidateMap.has(record.code)) candidateMap.set(record.code, record);
  };
  hs4Results.forEach(item => addRecord(item.record));
  for (const code of product.suggestedHs4Codes || []) addRecord(repository.findByCode(code));
  const siblingChapters = new Set((product.suggestedHs4Codes || []).map(code => code.slice(0, 2)));
  for (const chapter of siblingChapters) {
    for (const record of repository.getHierarchyRecords("HS4", chapter)) {
      if (candidateMap.size >= 30) break;
      addRecord(record);
    }
  }
  const allHs4Records = Array.from(candidateMap.values());
  const headConstrainedRecords = constrainByProductHead(allHs4Records, product.product);
  const allowedHs4Codes = new Set(headConstrainedRecords.map(record => record.code));
  const rankedHs4Results = hs4Results.filter(item => allowedHs4Codes.has(item.record.code));
  const hs4Ambiguity = ambiguousHierarchyResults(rankedHs4Results, {
    maximumMargin: 0.055,
    minimumRunnerScore: 0.34,
    minimumRunnerRatio: 0.9
  });
  let hierarchyAIUsed = false;
  let hs4Selection = null;
  if (canUseHierarchyAI(aiProvider) && hs4Ambiguity.length >= 2) {
    hierarchyAIUsed = true;
    hs4Selection = await safeSelectHierarchyBranch(
      aiProvider,
      query,
      product,
      hs4Ambiguity.map(item => compactHierarchyCandidate(item.record)),
      null
    );
  }
  const selectedHs4Record = hs4Selection?.selectedCode
    ? candidateMap.get(hs4Selection.selectedCode)
    : (rankedHs4Results[0]?.record || headConstrainedRecords[0]);
  if (!selectedHs4Record) return null;
  const hs4ScoreEntry = hs4Results.find(item => item.record.code === selectedHs4Record.code);
  let selected = hs4ScoreEntry || {
    record: selectedHs4Record,
    score: 0.72,
    canonicalScore: 0.7,
    bestConcept: 0.7,
    averageConcept: 0.7,
    ownSpecificity: 0.7
  };
  const otherHs4 = hs4Results.filter(item => item.record.code !== selectedHs4Record.code);
  let alternatives = [
    ...otherHs4.filter(item => item.record.code.slice(0, 2) === selectedHs4Record.code.slice(0, 2)),
    ...otherHs4.filter(item => item.record.code.slice(0, 2) !== selectedHs4Record.code.slice(0, 2))
  ].slice(0, 4);
  const hs6Results = repository.searchHierarchyBranches(query, {
    product,
    level: "HS6",
    parentPrefix: selectedHs4Record.code,
    limit: 30
  });
  const hs6Ambiguity = ambiguousHierarchyResults(hs6Results, {
    maximumMargin: 0.04,
    minimumRunnerScore: 0.3,
    minimumRunnerRatio: 0.92
  });
  let hs6Selection = null;
  if (!hierarchyAIUsed && canUseHierarchyAI(aiProvider) && hs6Ambiguity.length >= 2) {
    hierarchyAIUsed = true;
    hs6Selection = await safeSelectHierarchyBranch(
      aiProvider,
      query,
      product,
      hs6Ambiguity.map(item => compactHierarchyCandidate(item.record)),
      selectedHs4Record.code
    );
  }
  const aiSelectedHs6 = hs6Selection?.selectedCode
    ? hs6Results.find(item => item.record.code === hs6Selection.selectedCode)
    : null;
  const chosenHs6 = aiSelectedHs6 || hs6Results[0];
  const nextHs6 = hs6Results.find(item => item.record.code !== chosenHs6?.record.code);
  const hs6Margin = chosenHs6 ? chosenHs6.score - (nextHs6?.score || 0) : 0;
  if (
    chosenHs6 &&
    (
      Boolean(aiSelectedHs6) ||
      (
        chosenHs6.ownSpecificity >= 0.28 &&
        (hs6Margin >= 0.025 || chosenHs6.ownSpecificity >= 0.68) &&
        hasHierarchySpecificEvidence(selectedHs4Record, chosenHs6.record, query, product)
      )
    )
  ) {
      selected = chosenHs6;
      alternatives = hs6Results
        .filter(item => item.record.code !== chosenHs6.record.code)
        .slice(0, 4);
      selected.selectionReason = hs6Selection?.reason || hs4Selection?.reason || null;
  } else {
    selected.selectionReason = hs4Selection?.reason || null;
  }

  return {
    ...selected,
    alternatives,
    hs4Candidates: hs4Results,
    hs6Candidates: hs6Results
  };
}

function compactHierarchyCandidate(record) {
  return {
    code: record.code,
    level: record.level,
    description: sanitizeText(record.description, 280)
  };
}

function canUseHierarchyAI(aiProvider) {
  return Boolean(aiProvider?.available && typeof aiProvider.selectHierarchyBranch === "function");
}

async function safeSelectHierarchyBranch(aiProvider, query, product, candidates, currentCode) {
  try {
    return await aiProvider.selectHierarchyBranch(query, product, candidates, currentCode);
  } catch {
    return null;
  }
}

function ambiguousHierarchyResults(results, options = {}) {
  const ranked = (Array.isArray(results) ? results : [])
    .filter(item => item?.record?.code && Number.isFinite(Number(item.score)))
    .slice()
    .sort((left, right) => Number(right.score) - Number(left.score));
  if (ranked.length < 2) return [];
  const maximumMargin = Number(options.maximumMargin ?? 0.05);
  const minimumRunnerScore = Number(options.minimumRunnerScore ?? 0.32);
  const minimumRunnerRatio = Number(options.minimumRunnerRatio ?? 0.9);
  const topScore = Number(ranked[0].score);
  const runnerScore = Number(ranked[1].score);
  if (runnerScore < minimumRunnerScore) return [];
  if ((topScore - runnerScore) > maximumMargin) return [];
  if (topScore > 0 && (runnerScore / topScore) < minimumRunnerRatio) return [];
  return ranked.filter(item => {
    const score = Number(item.score);
    return (
      score >= minimumRunnerScore &&
      (topScore - score) <= maximumMargin &&
      (topScore <= 0 || (score / topScore) >= minimumRunnerRatio)
    );
  }).slice(0, 3);
}

function constrainByProductHead(records, productName) {
  const normalized = normalizeText(productName);
  const headPart = normalized.split(/\b(?:per|di|in|con|da|destinat[oaie]|utilizzat[oaie])\b/)[0].trim();
  const headTokens = tokenize(headPart).filter(token => token.length >= 4).slice(0, 2);
  if (!headTokens.length) return records;
  let constrained = records;
  for (const headToken of headTokens) {
    const forms = italianInflections(headToken);
    const matching = constrained.filter(record => {
      const candidateTokens = new Set(tokenize(record.description));
      return forms.some(form => candidateTokens.has(form));
    });
    if (matching.length) constrained = matching;
  }
  return constrained;
}

function italianInflections(token) {
  const forms = new Set([token]);
  if (token.endsWith("a")) forms.add(`${token.slice(0, -1)}e`);
  if (token.endsWith("o")) forms.add(`${token.slice(0, -1)}i`);
  if (token.endsWith("e")) forms.add(`${token.slice(0, -1)}i`);
  if (token.endsWith("i")) {
    forms.add(`${token.slice(0, -1)}o`);
    forms.add(`${token.slice(0, -1)}e`);
  }
  return Array.from(forms);
}

function hasHierarchySpecificEvidence(parent, child, query, product) {
  const parentTokens = new Set(tokenize(parent.description));
  const parentStems = new Set(Array.from(parentTokens).map(stemSearchToken));
  const specificTokens = tokenize(child.description)
    .filter(token => (
      token.length >= 4 &&
      token !== "altri" &&
      token !== "altre" &&
      !parentTokens.has(token) &&
      !parentStems.has(stemSearchToken(token)) &&
      !Array.from(parentTokens).some(parentToken => shareLongRoot(parentToken, token))
    ));
  if (!specificTokens.length) return false;
  const evidenceTokens = tokenize([
    query,
    product.product,
    product.function,
    product.use
  ].filter(Boolean).join(" "));
  return specificTokens.some(specific => evidenceTokens.some(evidence => tokensRelated(specific, evidence)));
}

function tokensRelated(left, right) {
  if (left === right) return true;
  const leftForms = italianInflections(left);
  const rightForms = italianInflections(right);
  if (leftForms.some(form => rightForms.includes(form))) return true;
  return left.length >= 5 && right.length >= 5 && (left.endsWith(right) || right.endsWith(left));
}

function shareLongRoot(left, right) {
  const limit = Math.min(left.length, right.length);
  let common = 0;
  while (common < limit && left[common] === right[common]) common += 1;
  return common >= 7;
}

function shouldReturnBranch(branch, topCandidate, description, product) {
  if (!topCandidate) return true;
  if (!topCandidate.record.code.startsWith(branch.record.code)) return true;
  return !hasSpecificLeafEvidence(topCandidate, description, branch.record, product);
}

function hasSpecificLeafEvidence(candidate, description, branchRecord, product = {}) {
  if (candidate?.searchResult?.exactCode) return true;
  if ((candidate?.searchResult?.facetAdjustment || 0) > 0.08) return true;
  const record = candidate?.record || {};
  const branchTokens = tokenize(branchRecord?.description || "");
  const queryTokens = tokenize([
    description,
    product.material,
    product.composition,
    product.power,
    product.displacement,
    ...(product.additionalCharacteristics || [])
  ].filter(Boolean).join(" ")).filter(token => (
    token.length >= 3 &&
    !/^\d+$/.test(token) &&
    !branchTokens.some(branchToken => tokensRelated(token, branchToken) || shareLongRoot(token, branchToken))
  ));
  if (!queryTokens.length) return false;
  const evidenceTokens = new Set(tokenize([
    record.leaf_description,
    ...(record.product_types || []),
    ...(record.synonyms || []),
    ...(record.keywords || [])
  ].filter(Boolean).join(" ")));
  const matches = queryTokens.filter(token => evidenceTokens.has(token)).length;
  return matches >= Math.max(1, Math.ceil(queryTokens.length * 0.5));
}

function semanticQuestions(details) {
  return (Array.isArray(details) ? details : []).slice(0, 4).map((detail, index) => ({
    id: `semantic_detail_${index + 1}`,
    text: `Puoi indicare ${String(detail).replace(/[?.]+$/, "").toLowerCase()}?`,
    reason: "Questo dato può cambiare la sottovoce CN/TARIC.",
    required: index === 0,
    options: []
  }));
}

function buildNextQuestion(details) {
  const values = (Array.isArray(details) ? details : []).filter(Boolean).slice(0, 3);
  if (!values.length) {
    return "Aggiungi composizione, caratteristiche tecniche e uso preciso del prodotto per scendere alla TARIC a 10 cifre.";
  }
  return `Indicami ${values.map(value => String(value).replace(/[?.]+$/, "").toLowerCase()).join("; ")}.`;
}

function branchAlternatives(branch) {
  const candidates = [branch, ...(branch.alternatives || [])];
  if (candidates.length <= 1) return [];
  const maxScore = Math.max(...candidates.map(item => item.score));
  const weights = candidates.map(item => Math.exp((item.score - maxScore) * 7));
  const total = weights.reduce((sum, value) => sum + value, 0) || 1;
  return (branch.alternatives || []).slice(0, 3).map(item => ({
    code: item.record.code,
    level: item.record.level,
    description: item.record.description,
    score: item.score,
    percentage: Math.round(item.score * 100),
    relativePercentage: Math.max(1, Math.round((weights[candidates.indexOf(item)] / total) * 100)),
    reliability: item.score >= 0.65 ? "MEDIA" : "BASSA",
    reasons: ["Famiglia ufficiale semanticamente vicina, mantenuta per confronto."]
  }));
}

function formatCodeForText(code) {
  const value = String(code || "");
  if (value.length <= 4) return value;
  return `${value.slice(0, 4)} ${value.slice(4)}`;
}

function buildReasons(product, candidate, validation, datasetInfo) {
  const record = candidate.record;
  const reasons = [];
  if (product.product) reasons.push(`Il prodotto è stato interpretato come ${product.product}.`);
  if (product.material && record.materials?.some(value => normalizeText(value) === normalizeText(product.material))) {
    reasons.push(`Il materiale principale (${product.material}) è coerente con il candidato.`);
  }
  if (product.function) reasons.push(`La funzione considerata è: ${product.function}.`);
  if (Array.isArray(record.result_notes)) reasons.push(...record.result_notes);
  reasons.push(`Il codice è stato valutato lungo la gerarchia ${validation.hierarchy.chapter.code} → ${validation.hierarchy.hs4.code} → ${validation.hierarchy.hs6.code} → ${validation.hierarchy.cn.code} → ${validation.hierarchy.taric.code}.`);
  if (candidate.notes.length) reasons.push("Sono state considerate le note collegate disponibili nel database locale.");
  else reasons.push("Nel database locale non sono ancora presenti note legali collegate a questa voce.");
  if (!datasetInfo.isOfficial) reasons.push("Il record è TEST DATA: il codice non è presentato come risultato normativo verificato.");
  return reasons;
}

function buildAssumptions(questions, record) {
  const defaults = Array.isArray(record?.default_assumptions)
    ? record.default_assumptions.filter(Boolean)
    : [];
  if (defaults.length) return defaults.slice(0, 4);
  return (questions || []).map(question => {
    if (question.id === "material") return "Il materiale non è specificato: viene usata la variante più compatibile nei dati disponibili.";
    if (question.id === "pasta_state") return "La pasta è considerata non cotta e non farcita.";
    if (question.id === "contains_egg") return "La presenza di uova non è indicata: viene usata l'ipotesi più compatibile con la voce proposta.";
    return `Dettaglio non specificato: ${String(question.text || "informazione utile").replace(/\?$/, "").toLowerCase()}.`;
  }).slice(0, 4);
}

function hierarchyItem(record, code, level, name) {
  return {
    code,
    level,
    name,
    description: record?.description || null,
    source: record?.source || null
  };
}

function candidateSummary(candidate) {
  const summary = {
    code: candidate.record.code,
    level: candidate.record.level,
    description: candidate.record.description,
    score: candidate.confidence.score,
    percentage: candidate.confidence.percentage,
    reliability: candidate.confidence.reliability,
    reasons: candidate.aiReasons || []
  };
  if (Number.isFinite(candidate.relativePercentage)) {
    summary.relativePercentage = candidate.relativePercentage;
  }
  return summary;
}

function alternativeReason(candidate, top, product) {
  const materials = candidate.record.materials || [];
  if (product.material && materials.length && !materials.some(value => normalizeText(value) === normalizeText(product.material))) {
    return `Materiale diverso da quello indicato: questa voce è associata a ${materials.join(", ")}, ma resta visibile per confronto.`;
  }
  if (candidate.confidence.score < top.confidence.score) {
    return "Corrispondenza complessiva meno specifica rispetto al candidato principale.";
  }
  return "Alternativa mantenuta per revisione manuale.";
}

function selectComparableCandidates(candidates, limit = 5) {
  if (!Array.isArray(candidates) || !candidates.length) return [];
  const relevant = candidates.filter((candidate, index) => (
    index === 0 ||
    candidate.confidence.components.productMatch >= 0.55 ||
    candidate.confidence.components.descriptionMatch >= 0.3
  ));
  return relevant.slice(0, limit);
}

function attachRelativePercentages(candidates, temperature = 8) {
  if (!Array.isArray(candidates) || !candidates.length) return [];
  const maxScore = Math.max(...candidates.map(candidate => candidate.confidence.score));
  const weights = candidates.map(candidate => Math.exp((candidate.confidence.score - maxScore) * temperature));
  const total = weights.reduce((sum, weight) => sum + weight, 0) || 1;
  const raw = weights.map(weight => (weight / total) * 100);
  const percentages = raw.map(value => Math.floor(value));
  let remaining = 100 - percentages.reduce((sum, value) => sum + value, 0);
  const remainderOrder = raw
    .map((value, index) => ({ index, remainder: value - percentages[index] }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (let index = 0; index < remaining; index += 1) {
    percentages[remainderOrder[index].index] += 1;
  }
  return candidates.map((candidate, index) => ({
    ...candidate,
    relativePercentage: percentages[index]
  }));
}

function productTitle(product) {
  return [product.product, product.material ? `in ${product.material}` : null]
    .filter(Boolean)
    .join(" ")
    .toUpperCase();
}

module.exports = {
  ClassificationEngine,
  buildReasons,
  buildAssumptions,
  candidateSummary,
  selectComparableCandidates,
  attachRelativePercentages,
  ambiguousHierarchyResults
};
