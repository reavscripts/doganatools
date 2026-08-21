"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const express = require("express");

const { TariffRepository } = require("../repositories/tariffRepository");
const { TariffHierarchyService } = require("../services/customsAI/tariffHierarchyService");
const { createCustomsAIService } = require("../services/customsAI/createCustomsAIService");
const { createAIProvider } = require("../services/customsAI/aiProvider");
const { createCustomsAIRouter } = require("../routes/customsAI");
const { CustomsDataImporter } = require("../services/customsAI/customsDataImporter");
const { parseAidaNomenclatureRows } = require("../services/customsAI/aidaNomenclatureClient");

const ROOT = path.resolve(__dirname, "..");
const DATASET = path.join(ROOT, "data", "customs", "processed", "customs-dataset.json");
const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "doganatools-customs-ai-"));
const SHARED_REPOSITORY = new TariffRepository({ datasetPath: DATASET });

test.after(() => {
  fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
});

function service(options = {}) {
  return createCustomsAIService({
    rootDir: ROOT,
    datasetPath: options.datasetPath || DATASET,
    repository: options.datasetPath ? undefined : SHARED_REPOSITORY,
    aiProvider: options.aiProvider,
    historyPath: path.join(TEMP_ROOT, `${Math.random().toString(36).slice(2)}.jsonl`),
    env: options.env || {}
  });
}

function semanticProvider(plan, preferredCodes) {
  return {
    name: "semantic-test",
    available: true,
    getStatus() { return { name: this.name, available: true }; },
    async analyzeSearchIntent() { return plan; },
    async selectHierarchyBranch(description, product, candidates, currentCode) {
      const allowed = new Set(candidates.map(candidate => candidate.code));
      const selectedCode = preferredCodes.find(code => allowed.has(code)) || currentCode || null;
      return { selectedCode, reason: "Selezione semantica verificata sui candidati ufficiali del test." };
    },
    async rankCandidates() { return []; }
  };
}

test("il dataset ufficiale contiene tutte le voci dichiarabili dello snapshot", () => {
  const repository = SHARED_REPOSITORY;
  const info = repository.getDatasetInfo();
  assert.equal(info.status, "official");
  assert.equal(info.isOfficial, true);
  assert.equal(info.recordCount, 16708);
  assert.equal(repository.load().coverage.english_fallback_rows, 0);
  assert.equal(repository.load().coverage.aida_supplemented_rows, 92);
});

test("ricerca esatta di un codice presente nel dataset", () => {
  const repository = SHARED_REPOSITORY;
  const result = repository.searchTariffCodes("8517 13 00 00");
  assert.equal(result.length, 1);
  assert.equal(result[0].record.code, "8517130000");
  assert.equal(result[0].exactCode, true);
});

test("costruisce la gerarchia HS, CN e TARIC", () => {
  const repository = SHARED_REPOSITORY;
  const hierarchy = new TariffHierarchyService(repository).buildHierarchy("2002101900");
  assert.deepEqual(
    [hierarchy.chapter.code, hierarchy.hs4.code, hierarchy.hs6.code, hierarchy.cn.code, hierarchy.taric.code],
    ["20", "2002", "200210", "20021019", "2002101900"]
  );
  assert.match(hierarchy.hs4.description, /Pomodori/i);
});

test("ricerca per descrizione e sinonimi senza AI", () => {
  const repository = SHARED_REPOSITORY;
  const results = repository.searchTariffCodes("rolling pin in legno", {
    product: { product: "mattarello", material: "legno", function: "utensile da cucina" }
  });
  assert.ok(results.length >= 3);
  assert.equal(results[0].record.code, "4419900000");
});

test("un prodotto incompleto restituisce subito il miglior codice con ipotesi dichiarate", async () => {
  const result = await service().classificationEngine.classify({
    description: "mattarello",
    answers: {},
    classificationDate: "2026-08-19"
  });
  assert.equal(result.status, "classified");
  assert.ok(result.classification.code);
  assert.ok(result.classification.assumptions.length >= 1);
  const materialQuestion = result.missingDetails.find(question => question.id === "material");
  assert.ok(materialQuestion);
  assert.equal(materialQuestion.required, true);
  assert.equal(result.classification.decisionStatus, "provisional");
  assert.equal(
    result.classification.relativePercentage +
      result.alternatives.reduce((sum, candidate) => sum + candidate.relativePercentage, 0),
    100
  );
});

test("pomodori pelati 600 g restituisce immediatamente la voce dedicata", async () => {
  const result = await service().classificationEngine.classify({
    description: "pomodori pelati 600gr",
    answers: {},
    classificationDate: "2026-08-19"
  });
  assert.equal(result.status, "classified");
  assert.equal(result.classification.code, "2002101900");
  assert.match(result.classification.description, /inferiore o uguale a 1 kg/i);
  assert.equal(result.classification.normativeVerified, true);
  assert.equal(result.classification.decisionStatus, "complete");
  assert.equal(result.clarification.activeQuestion, null);
  assert.equal(result.dataset.status, "official");
});

test("pomodori pelati senza peso chiede soltanto il dato che separa le sottovoci", async () => {
  const result = await service().classificationEngine.classify({
    description: "pomodori pelati",
    answers: {},
    classificationDate: "2026-08-19"
  });
  assert.equal(result.status, "classified");
  assert.equal(result.classification.decisionStatus, "provisional");
  assert.equal(result.clarification.activeQuestion.id, "net_weight");
  assert.match(result.clarification.activeQuestion.text, /peso netto/i);
  assert.deepEqual(result.missingDetails.map(question => question.id), ["net_weight"]);
});

test("la risposta guidata completa la classificazione senza ricominciare la ricerca", async () => {
  const currentService = service();
  const lightPack = await currentService.classificationEngine.classify({
    description: "pomodori pelati",
    answers: { net_weight: "600 g" },
    classificationDate: "2026-08-19"
  });
  const bulkPack = await currentService.classificationEngine.classify({
    description: "pomodori pelati",
    answers: { net_weight: "2 kg" },
    classificationDate: "2026-08-19"
  });
  assert.equal(lightPack.classification.code, "2002101900");
  assert.equal(bulkPack.classification.code, "2002101100");
  assert.equal(lightPack.classification.decisionStatus, "complete");
  assert.equal(bulkPack.classification.decisionStatus, "complete");
});

test("un dettaglio già risposto non viene richiesto di nuovo dal livello semantico", async () => {
  const result = await service({
    aiProvider: semanticProvider({
      canonicalProduct: "pomodori pelati conservati",
      function: "ortaggio preparato o conservato",
      use: "alimentazione umana",
      officialSearchConcepts: ["pomodori preparati", "pomodori interi o in pezzi"],
      excludedCandidateConcepts: ["pomodori freschi"],
      decisiveDetails: ["peso netto esatto", "materiale del contenitore"],
      suggestedHs4Codes: ["2002"]
    }, ["200210", "2002"])
  }).classificationEngine.classify({
    description: "pomodori pelati",
    answers: { net_weight: "600 g" },
    classificationDate: "2026-08-19"
  });
  assert.equal(result.classification.code, "2002101900");
  assert.equal(result.classification.decisionStatus, "complete");
  assert.equal(result.clarification.activeQuestion, null);
});

test("un dato non disponibile mantiene il risultato esplicitamente provvisorio", async () => {
  const result = await service().classificationEngine.classify({
    description: "pomodori pelati",
    answers: { net_weight: "Non disponibile" },
    classificationDate: "2026-08-19"
  });
  assert.equal(result.classification.decisionStatus, "provisional");
  assert.equal(result.clarification.activeQuestion, null);
  assert.equal(result.clarification.unresolvedAnswers.length, 1);
});

test("il peso della confezione riordina correttamente i pomodori pelati", async () => {
  const result = await service().classificationEngine.classify({
    description: "pomodori pelati 2kg",
    answers: {},
    classificationDate: "2026-08-19"
  });
  assert.equal(result.status, "classified");
  assert.equal(result.classification.code, "2002101100");
  assert.match(result.classification.description, /superiore a 1 kg/i);
});

test("pasta senza glutine restituisce immediatamente un risultato con assunzioni", async () => {
  const result = await service().classificationEngine.classify({
    description: "pasta senza glutine",
    answers: {},
    classificationDate: "2026-08-19"
  });
  assert.equal(result.status, "classified");
  assert.equal(result.classification.code, "1902191090");
  assert.ok(result.classification.assumptions.length >= 1);
  assert.ok(result.missingDetails.some(question => question.id === "product_state"));
});

test("motore diesel auto si ferma al ramo HS6 quando manca la potenza", async () => {
  const result = await service({
    aiProvider: semanticProvider({
      canonicalProduct: "motore diesel per autoveicoli",
      function: "propulsione di autoveicoli",
      use: "veicoli del capitolo 87",
      officialSearchConcepts: ["motori diesel", "motori a pistone con accensione per compressione"],
      excludedCandidateConcepts: ["autoveicolo completo", "motore marino"],
      decisiveDetails: ["potenza nominale in kW", "cilindrata"],
      suggestedHs4Codes: ["8408"]
    }, ["840820", "8408"])
  }).classificationEngine.classify({
    description: "motore diesel auto",
    answers: {},
    classificationDate: "2026-08-19"
  });
  assert.equal(result.status, "classified");
  assert.equal(result.classification.code, "840820");
  assert.equal(result.classification.level, "HS6");
  assert.equal(result.classification.completeTaric, false);
  assert.match(result.classification.description, /propulsione di veicoli del capitolo 87/i);
  assert.ok(result.missingDetails.some(question => question.id === "power" && question.required));
  assert.equal(result.alternatives.some(item => item.code.startsWith("8703")), false);
});

test("motore diesel auto con potenza restituisce la TARIC della fascia corretta", async () => {
  const result = await service({
    aiProvider: semanticProvider({
      canonicalProduct: "motore diesel per autoveicoli",
      function: "propulsione di autoveicoli",
      use: "veicoli del capitolo 87",
      officialSearchConcepts: ["motori diesel", "motori per autoveicoli"],
      excludedCandidateConcepts: ["autoveicolo completo", "trattore agricolo"],
      decisiveDetails: ["destinazione al montaggio industriale"],
      suggestedHs4Codes: ["8408"]
    }, ["840820", "8408"])
  }).classificationEngine.classify({
    description: "motore diesel auto 2.0 diesel 110 kW",
    answers: {},
    classificationDate: "2026-08-19"
  });
  assert.equal(result.status, "classified");
  assert.equal(result.classification.code, "8408205700");
  assert.equal(result.classification.level, "TARIC");
  assert.match(result.classification.description, /superiore a 100 kW ma inferiore o uguale a 200 kW/i);
  assert.ok(result.alternatives.every(item => item.code.startsWith("840820")));
});

test("il ramo ufficiale recupera le proprie sottovoci anche se non erano nei primi risultati lessicali", async () => {
  const result = await service({
    aiProvider: semanticProvider({
      canonicalProduct: "motore diesel",
      function: "organo propulsore per veicoli a motore",
      use: "alimentazione energia meccanica",
      officialSearchConcepts: ["motori diesel", "parti di motori", "mezzi di trasporto su strada"],
      excludedCandidateConcepts: ["veicolo completo", "motore marino"],
      decisiveDetails: ["tipo di veicolo", "potenza nominale in kW"],
      suggestedHs4Codes: ["8708", "8407", "8501"]
    }, ["840820", "8408"])
  }).classificationEngine.classify({
    description: "motore diesel auto",
    answers: { power: "200 kW" },
    classificationDate: "2026-08-19"
  });
  assert.equal(result.status, "classified");
  assert.equal(result.classification.code, "8408205700");
  assert.equal(result.classification.decisionStatus, "complete");
});

test("la ricerca semantica distingue il cibo per cavalli dai cavalli vivi", async () => {
  const result = await service({
    aiProvider: semanticProvider({
      canonicalProduct: "cibo per cavalli",
      function: "alimentazione animale",
      use: "consumo da parte di equini",
      officialSearchConcepts: ["preparazioni per alimentazione animale", "mangimi per equini"],
      excludedCandidateConcepts: ["cavalli vivi", "macchine per mangimi"],
      decisiveDetails: ["composizione del mangime", "stato fisico"],
      suggestedHs4Codes: ["2309"]
    }, ["2309"])
  }).classificationEngine.classify({
    description: "cibo per cavalli",
    answers: {},
    classificationDate: "2026-08-19"
  });
  assert.equal(result.status, "classified");
  assert.equal(result.classification.code, "2309");
  assert.equal(result.classification.level, "HS4");
  assert.match(result.classification.description, /alimentazione degli animali/i);
  assert.equal(result.alternatives.some(item => item.code.startsWith("0101")), false);
});

test("la ricerca semantica distingue pizza da pizzi tessili", async () => {
  const result = await service({
    aiProvider: semanticProvider({
      canonicalProduct: "pizza congelata",
      function: "prodotto alimentare da forno",
      use: "consumo umano",
      officialSearchConcepts: ["prodotti della panetteria", "preparazioni da forno"],
      excludedCandidateConcepts: ["pizzi tessili", "forni e macchine"],
      decisiveDetails: ["composizione degli ingredienti"],
      suggestedHs4Codes: ["1905"]
    }, ["1905"])
  }).classificationEngine.classify({
    description: "pizza congelata",
    answers: {},
    classificationDate: "2026-08-19"
  });
  assert.equal(result.status, "classified");
  assert.equal(result.classification.code, "1905");
  assert.equal(result.classification.level, "HS4");
  assert.equal(result.alternatives.some(item => item.code.startsWith("5804")), false);
});

test("il materiale riordina i candidati ma mantiene visibili le alternative", async () => {
  const result = await service().classificationEngine.classify({
    description: "mattarello di legno",
    answers: {},
    classificationDate: "2026-08-19"
  });
  assert.equal(result.status, "classified");
  assert.equal(result.classification.code, "4419900000");
  assert.ok(result.alternatives.length >= 2);
  assert.ok(result.alternatives.every(item => item.differenceReason));
  assert.ok(result.alternatives.some(item => item.code === "3924100090"));
  assert.ok(result.alternatives.some(item => item.code === "7323930090"));
  assert.equal(
    result.classification.relativePercentage +
      result.alternatives.reduce((sum, candidate) => sum + candidate.relativePercentage, 0),
    100
  );
  assert.equal(result.classification.normativeVerified, true);
});

test("una risposta materiale aggiorna l'ordine senza applicare filtri rigidi", async () => {
  const result = await service().classificationEngine.classify({
    description: "mattarello",
    answers: { material: "Plastica" },
    classificationDate: "2026-08-19"
  });
  assert.equal(result.status, "classified");
  assert.equal(result.classification.code, "3924100090");
  assert.ok(result.alternatives.some(item => item.code === "4419900000"));
  assert.ok(result.alternatives.some(item => item.code === "7323930090"));
});

test("classifica tramite fallback lessicale quando l'AI non è configurata", async () => {
  const currentService = service({ env: {} });
  assert.equal(currentService.aiProvider.available, false);
  const result = await currentService.classificationEngine.classify({
    description: "crema cosmetica per il viso",
    answers: {},
    classificationDate: "2026-08-19"
  });
  assert.equal(result.status, "classified");
  assert.equal(result.classification.code, "3304990000");
});

test("la ricerca comune funziona su capitoli differenti", async () => {
  const cases = [
    ["smartphone", "8517130000"],
    ["computer portatile", "8471300000"],
    ["maglietta cotone", "6109100010"],
    ["scarpe da ginnastica", "6403"],
    ["bicicletta elettrica", "871160"],
    ["caffe tostato", "09012"]
  ];
  const currentService = service({ env: {} });
  for (const [description, expectedPrefix] of cases) {
    const result = await currentService.classificationEngine.classify({
      description,
      answers: {},
      classificationDate: "2026-08-19"
    });
    assert.equal(result.status, "classified", description);
    assert.ok(result.classification.code.startsWith(expectedPrefix), `${description}: ${result.classification.code}`);
  }
});

test("dataset mancante: analizza ma non inventa alcun codice", async () => {
  const missingPath = path.join(TEMP_ROOT, "missing", "customs-dataset.json");
  const result = await service({ datasetPath: missingPath }).classificationEngine.classify({
    description: "mattarello di legno",
    answers: {},
    classificationDate: "2026-08-19"
  });
  assert.equal(result.status, "dataset_missing");
  assert.equal(result.classification, undefined);
});

test("provider OpenAI senza API key resta disattivato e il fallback è disponibile", () => {
  const provider = createAIProvider({
    env: { CUSTOMS_AI_PROVIDER: "openai", CUSTOMS_AI_MODEL: "configured-by-deployment" }
  });
  assert.equal(provider.available, false);
  assert.equal(provider.reason, "api_key_missing");
});

test("DOGANA AI risponde anche alle domande doganali basilari", async () => {
  const result = await service().classificationEngine.classify({
    description: "Qual è la differenza tra HS, CN e TARIC?",
    answers: {},
    classificationDate: "2026-08-19"
  });
  assert.equal(result.status, "answered");
  assert.match(result.answer.title, /HS, CN e TARIC/i);
  assert.ok(result.answer.bullets.some(item => /10 cifre/i.test(item)));
  assert.match(result.answer.source.url, /^https:\/\/taxation-customs\.ec\.europa\.eu\//);
});

test("endpoint analyze e measures sono collegati", async () => {
  const app = express();
  app.use(express.json({ limit: "64kb" }));
  const apiService = service({ env: {} });
  app.use("/api/customs-ai", createCustomsAIRouter({
    service: apiService
  }));
  const server = await new Promise(resolve => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  try {
    const address = server.address();
    const base = `http://127.0.0.1:${address.port}`;
    const analyze = await fetch(`${base}/api/customs-ai/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "mattarello di legno" })
    });
    assert.equal(analyze.status, 200);
    const analyzeBody = await analyze.json();
    assert.equal(analyzeBody.status, "classified");
    assert.equal(analyzeBody.classification.code, "4419900000");

    const measures = await fetch(`${base}/api/customs-ai/measures`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "4419900000", flow: "import", operationDate: "2026-08-19" })
    });
    const measuresBody = await measures.json();
    assert.equal(measures.status, 200);
    assert.equal(measuresBody.status, "not_available");
    assert.deepEqual(measuresBody.measures, []);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test("importer valida e costruisce la gerarchia in dry-run", () => {
  const importer = new CustomsDataImporter();
  const sourcePath = path.join(TEMP_ROOT, "small-import.json");
  fs.writeFileSync(sourcePath, JSON.stringify({
    schema_version: 1,
    tariff_codes: [{ code: "8517130000", description: "Smartphone" }]
  }));
  const { report, dataset } = importer.importFile({
    sourcePath,
    targetPath: path.join(TEMP_ROOT, "not-written.json"),
    source: "TEST DATA",
    sourceVersion: "dry-run-test",
    validFrom: "2026-01-01",
    official: false,
    dryRun: true
  });
  assert.equal(report.dryRun, true);
  assert.ok(dataset.tariff_hierarchy.length >= 5);
  assert.equal(fs.existsSync(report.targetPath), false);
});

test("parser AIDA associa codice, suffisso e descrizione italiana", () => {
  const html = `
    <a href="javascript:linkToPostKey('NomenclatureImportServlet',15,1,'-1','102','1','2','3','02074120','10','80','09/07/2026','09/07/2026','09/07/2026')">0207 4120 10</a>
    <TD class=TDOUTPUTSX style="border-width:0px">di anatra di Pechino</TD>`;
  const rows = parseAidaNomenclatureRows(html);
  assert.equal(rows.get("0207412010 80"), "di anatra di Pechino");
});
