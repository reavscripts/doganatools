"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { TariffRepository } = require("../repositories/tariffRepository");
const { TaricMeasuresService } = require("../services/customsAI/taricMeasuresService");
const { validateMeasuresPayload, CustomsInputError } = require("../services/customsAI/inputValidator");
const {
  buildTaricMeasureTables,
  parseInlineMeasureConditions,
  parseSupplementaryUnits
} = require("../services/customsAI/officialTaricImporter");
const { OllamaProvider } = require("../services/customsAI/aiProvider");
const { ambiguousHierarchyResults } = require("../services/customsAI/classificationEngine");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doganatools-measures-"));
const datasetPath = path.join(tempRoot, "dataset.json");

test.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

function writeDataset() {
  const metadata = {
    source: "EU TARIC — DG TAXUD",
    source_version: "2026-08",
    retrieved_at: "2026-08-24T00:00:00.000Z"
  };
  const emptyTables = [
    "tariff_descriptions", "tariff_hierarchy", "section_notes", "chapter_notes",
    "heading_notes", "classification_rules", "classification_examples",
    "classification_regulations", "bti_examples"
  ];
  const dataset = {
    schema_version: 3,
    dataset_status: "official",
    tariff_codes: [
      { code: "3905120000", level: "TARIC", description: "Polivinilacetato in dispersione acquosa", valid_from: "2026-01-01", valid_to: null, ...metadata },
      { code: "4401310000", level: "TARIC", description: "Pellet di legno", valid_from: "2026-01-01", valid_to: null, ...metadata }
    ],
    taric_measures: [
      {
        id: "waste-control",
        code: "3905000000",
        flow: "export",
        valid_from: "2026-01-01",
        valid_to: null,
        geographical_area_code: "1008",
        measure_type_code: "710",
        measure_type: "Controllo all'esportazione - Rifiuti",
        legal_reference: "1R 1157/24",
        conditions: [
          { condition_code: "Y", certificate_code: "Y923", action_code: "04" },
          { condition_code: "Y", certificate_code: "Y160", action_code: "04" }
        ],
        footnotes: [{ code: "CD572" }],
        excluded_countries: ["CA"]
      },
      {
        id: "additional-code-option",
        code: "4401310000",
        flow: "export",
        valid_from: "2026-01-01",
        valid_to: null,
        geographical_area_code: "1008",
        measure_type_code: "409",
        measure_type: "Restrizione commerciale",
        additional_code: "4099",
        conditions: [],
        footnotes: []
      }
    ],
    additional_codes: [{ code: "4099", description: "Altri: nessuna restrizione specifica", language: "IT" }],
    document_codes: [
      { code: "Y923", description: "Prodotto non soggetto al controllo indicato", language: "IT" },
      { code: "Y160", description: "Dichiarazione prevista dalla misura", language: "IT" }
    ],
    footnotes: [{ code: "CD572", description: "Nota applicativa della misura", language: "IT" }],
    geographical_areas: [{
      code: "1008",
      acronym: "ALLTC",
      members: [{ code: "US", valid_from: "2020-01-01", valid_to: null }, { code: "CA", valid_from: "2020-01-01", valid_to: null }]
    }],
    data_versions: [{ id: "eu-taric-2026-08", active: true, is_official: true }]
  };
  for (const table of emptyTables) dataset[table] = [];
  fs.writeFileSync(datasetPath, JSON.stringify(dataset));
}

test("valida CN8, paese di destinazione e codice addizionale", () => {
  const input = validateMeasuresPayload({
    code: "44013100",
    flow: "export",
    destinationCountry: "us",
    additionalCode: "4099",
    operationDate: "2026-08-24"
  });
  assert.equal(input.code, "4401310000");
  assert.equal(input.cnCode, "44013100");
  assert.equal(input.destinationCountry, "US");
  assert.equal(input.additionalCode, "4099");
  assert.throws(
    () => validateMeasuresPayload({ code: "44013100", flow: "export" }),
    CustomsInputError
  );
});

test("risolve una misura ereditata per paese, condizioni e documenti", () => {
  writeDataset();
  const repository = new TariffRepository({ datasetPath });
  const result = new TaricMeasuresService(repository).getMeasures({
    code: "3905120000",
    cnCode: "39051200",
    flow: "export",
    destinationCountry: "US",
    operationDate: "2026-08-24",
    additionalCode: null
  });
  assert.equal(result.status, "available");
  assert.equal(result.decisionStatus, "conditions_to_verify");
  assert.equal(result.measures[0].measure_type, "Controllo all'esportazione - Rifiuti");
  assert.deepEqual(result.documentCodes.map(item => item.code), ["Y923", "Y160"]);
  assert.equal(result.measures[0].footnotes[0].description, "Nota applicativa della misura");
});

test("applica le esclusioni dal gruppo geografico", () => {
  writeDataset();
  const repository = new TariffRepository({ datasetPath });
  const measures = repository.getMeasures("3905120000", "2026-08-24", {
    flow: "export",
    destinationCountry: "CA",
    operationDate: "2026-08-24"
  });
  assert.deepEqual(measures, []);
});

test("applica una misura collegata direttamente a un singolo paese", () => {
  writeDataset();
  const parsed = JSON.parse(fs.readFileSync(datasetPath, "utf8"));
  parsed.taric_measures.push({
    id: "direct-us",
    code: "3905120000",
    flow: "export",
    valid_from: "2026-01-01",
    valid_to: null,
    geographical_area_code: "US",
    measure_type_code: "999",
    measure_type: "Misura nazionale di destinazione",
    conditions: [],
    footnotes: []
  });
  fs.writeFileSync(datasetPath, JSON.stringify(parsed));
  const repository = new TariffRepository({ datasetPath });
  assert.ok(repository.getMeasures("3905120000", "2026-08-24", {
    flow: "export", destinationCountry: "US", operationDate: "2026-08-24"
  }).some(item => item.id === "direct-us"));
  assert.ok(!repository.getMeasures("3905120000", "2026-08-24", {
    flow: "export", destinationCountry: "JP", operationDate: "2026-08-24"
  }).some(item => item.id === "direct-us"));
});

test("restituisce il codice addizionale comunitario applicabile", () => {
  writeDataset();
  const repository = new TariffRepository({ datasetPath });
  const result = new TaricMeasuresService(repository).getMeasures({
    code: "4401310000",
    cnCode: "44013100",
    flow: "export",
    destinationCountry: "US",
    operationDate: "2026-08-24",
    additionalCode: "4099"
  });
  assert.deepEqual(result.additionalCodes, [{ code: "4099", description: "Altri: nessuna restrizione specifica" }]);
});

test("carica soltanto il file misure del capitolo TARIC richiesto", () => {
  writeDataset();
  const dataset = JSON.parse(fs.readFileSync(datasetPath, "utf8"));
  const chapterDirectory = path.join(tempRoot, "taric-measures");
  fs.mkdirSync(chapterDirectory, { recursive: true });
  fs.writeFileSync(path.join(chapterDirectory, "44.json"), JSON.stringify({
    schema_version: 1,
    chapter: "44",
    measures: dataset.taric_measures.filter(item => item.code.startsWith("44"))
  }));
  dataset.taric_measures = [];
  dataset.coverage = {
    measures_imported: true,
    measures: 1,
    measures_storage: "chapter_files",
    measures_directory: "taric-measures"
  };
  fs.writeFileSync(datasetPath, JSON.stringify(dataset));
  const repository = new TariffRepository({ datasetPath });
  const result = new TaricMeasuresService(repository).getMeasures({
    code: "4401310000",
    cnCode: "44013100",
    flow: "export",
    destinationCountry: "US",
    operationDate: "2026-08-24",
    additionalCode: "4099"
  });
  assert.equal(result.status, "available");
  assert.equal(result.measures.length, 1);
  assert.equal(repository.measureChapterCache.size, 1);
});

test("preferisce il database runtime senza modificare il dataset incluso in Git", () => {
  writeDataset();
  const selectionRoot = path.join(tempRoot, "runtime-selection");
  const processedDirectory = path.join(selectionRoot, "data", "customs", "processed");
  const runtimeDirectory = path.join(selectionRoot, "data", "customs", "runtime");
  fs.mkdirSync(processedDirectory, { recursive: true });
  fs.mkdirSync(runtimeDirectory, { recursive: true });
  const bundled = JSON.parse(fs.readFileSync(datasetPath, "utf8"));
  bundled.data_versions[0].id = "bundled";
  const runtime = structuredClone(bundled);
  runtime.data_versions[0].id = "runtime";
  fs.writeFileSync(path.join(processedDirectory, "customs-dataset.json"), JSON.stringify(bundled));
  fs.writeFileSync(path.join(runtimeDirectory, "customs-dataset.json"), JSON.stringify(runtime));
  const repository = new TariffRepository({ rootDir: selectionRoot });
  assert.equal(repository.getDatasetInfo().version.id, "runtime");
  assert.match(repository.datasetPath, /data[\\/]customs[\\/]runtime[\\/]customs-dataset\.json$/);
});

test("normalizza le estrazioni ufficiali e collega condizioni e note", () => {
  const tables = buildTaricMeasureTables({
    additionalRows: [["4099", "IT", "Altri"]],
    documentRows: [["Y923", "IT", "Esenzione", "01-01-2020", ""]],
    geographicalRows: [["1008", "01-01-2020", "IT", "ALLTC", "Tutti i paesi terzi", "1", "US", "Stati Uniti", "01-01-2020", ""]],
    footnoteRows: [["CD572", "IT", "Nota"]],
    conditionRows: [["3905000000", "", "", "01-01-2026", "", "1008", "710", "Y", "1", "Y923", "", "", "", "", "04"]],
    exclusionRows: [],
    measureFootnoteRows: [["3905000000", "", "", "1008", "01-01-2026", "", "710", "Tutti", "Controllo", "CD572"]],
    importRows: [],
    exportRows: [["3905000000", "", "", "01-01-2026", "", "", "Tutti", "Controllo export", "1R 1157/24", "Condizioni", "1008", "710"]]
  });
  assert.equal(tables.taric_measures.length, 1);
  assert.equal(tables.taric_measures[0].conditions[0].certificate_code, "Y923");
  assert.equal(tables.taric_measures[0].footnotes[0].description, "Nota");
});

test("estrae condizioni incorporate e unità supplementari senza eccezioni per codice", () => {
  const conditions = parseInlineMeasureConditions("Cond: R 0.036/KGM(28):; R 0.000/KGM(10):");
  assert.equal(conditions.length, 2);
  assert.deepEqual(conditions.map(item => item.measurement_unit), ["KGM", "KGM"]);
  assert.deepEqual(conditions.map(item => item.action_code), ["28", "10"]);
  assert.deepEqual(parseSupplementaryUnits("Supplementary unit", "Cond: R 0.036/KGM(28):; R 0.000/KGM(10):", conditions), [{
    code: "KGM",
    qualifier: null,
    declaration_code: null,
    description: "Chilogrammo",
    symbol: "kg"
  }]);
});

test("restituisce per 44152020 le misure export ereditate, i CADD e l'unità supplementare", () => {
  const tables = buildTaricMeasureTables({
    additionalRows: [
      ["4056", "IT", "Beni soggetti al regolamento (CE) n. 1210/2003", "01-01-2007", "01-01-2007", ""],
      ["4099", "IT", "Altri: nessuna restrizione", "01-01-2007", "01-01-2007", ""]
    ],
    documentRows: [
      ["Y935", "IT", "Merci fuori dal campo del regolamento (UE) n. 1332/2013", "15-12-2013", "15-12-2013", ""],
      ["E012", "IT", "Licenza di esportazione di beni culturali", "02-03-2009", "02-03-2009", ""],
      ["Y903", "IT", "Merci non comprese nell'elenco dei beni culturali", "02-03-2009", "02-03-2009", ""]
    ],
    geographicalRows: [["1008", "01-01-2000", "IT", "ALLTC", "Tutti i paesi terzi", "1", "US", "Stati Uniti", "01-01-2000", ""]],
    footnoteRows: [],
    conditionRows: [],
    exclusionRows: [],
    measureFootnoteRows: [],
    importRows: [],
    exportRows: [
      ["4400000000", "4056", "", "01-01-2007", "", "", "All third countries", "Restriction on export", "Regulation 1210/03", "", "1008", "467"],
      ["4400000000", "4099", "", "01-01-2007", "", "", "All third countries", "Restriction on export", "Regulation 1210/03", "", "1008", "467"],
      ["4400000000", "", "", "15-12-2013", "", "", "All third countries", "Export authorization", "Regulation 1332/13", "Cond: B cert: Y-935 (25):; B (05):", "1008", "473"],
      ["4415000000", "", "", "02-03-2009", "", "", "All third countries", "Export control on cultural goods", "Regulation 0116/09", "Cond: Y cert: E-012 (29):; Y cert: Y-903 (29):; Y (09):", "1008", "735"],
      ["4415202000", "", "", "01-01-2008", "", "", "ERGA OMNES", "Supplementary unit", "Regulation 1734/96", "NAR", "1011", "109"]
    ]
  });
  assert.equal(tables.taric_measures.length, 5);
  assert.deepEqual(
    tables.taric_measures.find(item => item.measure_type_code === "473").conditions.map(item => item.certificate_code),
    ["Y935", null]
  );
  assert.deepEqual(
    tables.taric_measures.find(item => item.measure_type_code === "735").conditions.map(item => item.certificate_code),
    ["E012", "Y903", null]
  );
  assert.deepEqual(tables.taric_measures.find(item => item.measure_type_code === "109").supplementary_units, [{
    code: "NAR",
    qualifier: null,
    declaration_code: "PCE",
    description: "Numero di pezzi",
    symbol: "p/st"
  }]);

  writeDataset();
  const dataset = JSON.parse(fs.readFileSync(datasetPath, "utf8"));
  dataset.tariff_codes.push({
    code: "4415202000",
    level: "TARIC",
    description: "Palette di carico semplici in legno",
    valid_from: "2026-01-01",
    valid_to: null,
    source: "EU TARIC — DG TAXUD",
    source_version: "2026-08",
    retrieved_at: "2026-08-24T00:00:00.000Z"
  });
  dataset.taric_measures = tables.taric_measures;
  dataset.additional_codes = tables.additional_codes;
  dataset.document_codes = tables.document_codes;
  dataset.footnotes = tables.footnotes;
  dataset.geographical_areas = tables.geographical_areas;
  fs.writeFileSync(datasetPath, JSON.stringify(dataset));

  const result = new TaricMeasuresService(new TariffRepository({ datasetPath })).getMeasures({
    code: "4415202000",
    cnCode: "44152020",
    flow: "export",
    destinationCountry: "US",
    operationDate: "2026-08-24",
    additionalCode: null
  });
  assert.equal(result.status, "available");
  assert.ok(result.additionalCodes.some(item => item.code === "4099"));
  assert.deepEqual(result.documentCodes.map(item => item.code).sort(), ["E012", "Y903", "Y935"]);
  assert.deepEqual(result.supplementaryUnits.map(item => [item.declaration_code, item.code]), [["PCE", "NAR"]]);
  assert.ok(!result.restrictions.some(item => item.measure_type_code === "109"));
});

test("Ollama usa i limiti rapidi e mette in cache l'interpretazione", async () => {
  let chatCalls = 0;
  let requestBody = null;
  const provider = new OllamaProvider({
    fetch: async (url, options = {}) => {
      if (url.endsWith("/api/tags")) {
        return {
          ok: true,
          async json() { return { models: [{ name: "qwen3.5:9b" }] }; }
        };
      }
      chatCalls += 1;
      requestBody = JSON.parse(options.body);
      return {
        ok: true,
        async json() {
          return { message: { content: JSON.stringify({
            canonicalProduct: "pellet di legno",
            function: null,
            use: null,
            officialSearchConcepts: ["legno", "pellet"],
            excludedCandidateConcepts: [],
            decisiveDetails: [],
            suggestedHs4Codes: ["4401"]
          }) } };
        }
      };
    },
    autoStart: false
  });
  await provider.analyzeSearchIntent("pellet di legno", {});
  await provider.analyzeSearchIntent("pellet di legno", {});
  assert.equal(chatCalls, 1);
  assert.equal(requestBody.keep_alive, "4h");
  assert.equal(requestBody.options.num_predict, 200);
  assert.equal(requestBody.options.num_ctx, 2048);
});

test("Ollama usa un modello locale compatibile e ritenta soltanto una risposta JSON troncata", async () => {
  let chatCalls = 0;
  const requestBodies = [];
  const provider = new OllamaProvider({
    fetch: async (url, options = {}) => {
      if (url.endsWith("/api/tags")) {
        return {
          ok: true,
          async json() { return { models: [{ name: "qwen3:8b" }] }; }
        };
      }
      chatCalls += 1;
      requestBodies.push(JSON.parse(options.body));
      return {
        ok: true,
        async json() {
          return {
            message: {
              content: chatCalls === 1
                ? "{\"canonicalProduct\":\"pellet"
                : JSON.stringify({
                  canonicalProduct: "pellet di legno",
                  function: null,
                  use: null,
                  officialSearchConcepts: ["legno", "pellet"],
                  excludedCandidateConcepts: [],
                  decisiveDetails: [],
                  suggestedHs4Codes: ["4401"]
                })
            }
          };
        }
      };
    },
    autoStart: false
  });
  const intent = await provider.analyzeSearchIntent("pellet di legno", {});
  assert.equal(intent.canonicalProduct, "pellet di legno");
  assert.equal(chatCalls, 2);
  assert.equal(requestBodies[0].model, "qwen3:8b");
  assert.equal(requestBodies[0].options.num_predict, 200);
  assert.ok(requestBodies[1].options.num_predict > 200);
  assert.equal(provider.getStatus().modelFallback, "qwen3:8b");
});

test("rileva come ambigui soltanto i candidati gerarchici realmente vicini", () => {
  const record = code => ({ code });
  assert.equal(ambiguousHierarchyResults([
    { record: record("3905"), score: 0.8 },
    { record: record("3906"), score: 0.55 }
  ]).length, 0);
  assert.deepEqual(ambiguousHierarchyResults([
    { record: record("3905"), score: 0.8 },
    { record: record("3906"), score: 0.78 }
  ]).map(item => item.record.code), ["3905", "3906"]);
});
