"use strict";

const path = require("path");
const { MODULE_VERSION } = require("./constants");
const { createAIProvider } = require("./aiProvider");
const { ProductAnalyzer } = require("./productAnalyzer");
const { TariffSearchService } = require("./tariffSearchService");
const { TariffHierarchyService } = require("./tariffHierarchyService");
const { ConfidenceService } = require("./confidenceService");
const { ClassificationValidator } = require("./classificationValidator");
const { SourceService } = require("./sourceService");
const { ClassificationHistoryService } = require("./classificationHistoryService");
const { TaricMeasuresService } = require("./taricMeasuresService");
const { ClassificationEngine } = require("./classificationEngine");
const { TariffRepository } = require("../../repositories/tariffRepository");

function createCustomsAIService(options = {}) {
  const rootDir = options.rootDir || path.resolve(__dirname, "../..");
  const repository = options.repository || new TariffRepository({
    rootDir,
    datasetPath: options.datasetPath
  });
  if (options.preloadDataset !== false && repository.isInstalled()) repository.load();
  const aiProvider = options.aiProvider || createAIProvider({ env: options.env, fetch: options.fetch });
  const productAnalyzer = new ProductAnalyzer({ aiProvider });
  const tariffSearchService = new TariffSearchService(repository);
  const hierarchyService = new TariffHierarchyService(repository);
  const confidenceService = new ConfidenceService();
  const classificationValidator = new ClassificationValidator(hierarchyService);
  const sourceService = new SourceService(repository);
  const historyService = options.historyService || new ClassificationHistoryService({
    rootDir,
    historyPath: options.historyPath
  });
  const classificationEngine = new ClassificationEngine({
    moduleVersion: MODULE_VERSION,
    repository,
    aiProvider,
    productAnalyzer,
    tariffSearchService,
    confidenceService,
    classificationValidator,
    sourceService,
    historyService
  });
  const taricMeasuresService = new TaricMeasuresService(repository);
  return {
    moduleVersion: MODULE_VERSION,
    repository,
    aiProvider,
    productAnalyzer,
    tariffSearchService,
    hierarchyService,
    confidenceService,
    classificationEngine,
    taricMeasuresService
  };
}

module.exports = { createCustomsAIService };
