"use strict";

class ClassificationValidator {
  constructor(hierarchyService) {
    this.hierarchyService = hierarchyService;
  }

  validate(candidate, datasetInfo) {
    const hierarchyValidation = this.hierarchyService.validateHierarchy(candidate?.record?.code);
    const errors = [...hierarchyValidation.errors];
    const warnings = [];
    if (!candidate?.record?.description) errors.push("Descrizione del codice assente nel dataset.");
    if (!datasetInfo?.isOfficial) {
      warnings.push("Il risultato deriva da TEST DATA e non è una classificazione normativa verificata.");
    }
    if (!candidate?.record?.source_id) {
      warnings.push("Fonte puntuale non associata al codice.");
    }
    return {
      valid: errors.length === 0,
      errors,
      warnings,
      hierarchy: hierarchyValidation.hierarchy || null,
      normativeVerified: Boolean(datasetInfo?.isOfficial && errors.length === 0)
    };
  }
}

module.exports = { ClassificationValidator };
