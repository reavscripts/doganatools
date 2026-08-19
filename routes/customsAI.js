"use strict";

const express = require("express");
const { createCustomsAIService } = require("../services/customsAI/createCustomsAIService");
const {
  CustomsInputError,
  validateClassificationPayload,
  validateMeasuresPayload
} = require("../services/customsAI/inputValidator");

function createCustomsAIRouter(options = {}) {
  const router = express.Router();
  const service = options.service || createCustomsAIService(options);

  router.get("/status", (req, res) => {
    res.json({
      success: true,
      module: "DOGANA AI",
      moduleVersion: service.moduleVersion,
      dataset: service.repository.getDatasetInfo(),
      ai: service.aiProvider.getStatus()
    });
  });

  router.post("/analyze", asyncHandler(async (req, res) => {
    const input = validateClassificationPayload(req.body);
    const result = await service.classificationEngine.classify(input);
    res.json({ success: true, ...result });
  }));

  router.post("/classify", asyncHandler(async (req, res) => {
    const input = validateClassificationPayload(req.body);
    const result = await service.classificationEngine.classify(input);
    res.json({ success: true, ...result });
  }));

  router.post("/measures", asyncHandler(async (req, res) => {
    const input = validateMeasuresPayload(req.body);
    const result = service.taricMeasuresService.getMeasures(input);
    res.json({ success: true, ...result });
  }));

  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof CustomsInputError) {
      return res.status(error.statusCode).json({
        success: false,
        code: error.code,
        error: error.message
      });
    }
    console.error("Errore DOGANA AI:", error?.stack || error);
    return res.status(500).json({
      success: false,
      code: "CUSTOMS_AI_ERROR",
      error: "DOGANA AI non è momentaneamente disponibile."
    });
  });

  return router;
}

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

module.exports = { createCustomsAIRouter };
