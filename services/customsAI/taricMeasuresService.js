"use strict";

class TaricMeasuresService {
  constructor(repository) {
    this.repository = repository;
  }

  getMeasures(input) {
    const datasetInfo = this.repository.getDatasetInfo();
    if (!datasetInfo.installed) {
      return {
        status: "dataset_missing",
        dataAvailable: false,
        input,
        measures: [],
        message: "Il database TARIC non è ancora stato importato; le misure non sono disponibili."
      };
    }
    if (datasetInfo.measuresImported === false) {
      return {
        status: "measures_dataset_missing",
        dataAvailable: false,
        input,
        measures: [],
        restrictions: [],
        additionalCodes: [],
        documentCodes: [],
        supplementaryUnits: [],
        message: "La nomenclatura è installata, ma le tabelle ufficiali delle misure non sono ancora state importate. Esegui l'aggiornamento TARIC completo."
      };
    }
    const measures = this.repository.getMeasures(input.code, input.operationDate, input);
    const additionalCodes = uniqueByCode(measures
      .filter(item => item.additional_code)
      .map(item => ({ code: item.additional_code, description: item.additional_code_description || null })));
    const documentCodes = uniqueByCode(measures.flatMap(item => (
      (item.conditions || [])
        .filter(condition => condition.certificate_code)
        .map(condition => ({
          code: condition.certificate_code,
          description: condition.document?.description || null,
          condition: condition.condition_code || null
        }))
    )));
    const supplementaryUnits = uniqueByUnit(measures.flatMap(item => item.supplementary_units || []));
    const restrictions = measures.filter(item => isRestriction(item));
    const decisionStatus = measureDecisionStatus(measures, restrictions);
    return {
      status: measures.length ? "available" : "not_available",
      dataAvailable: measures.length > 0,
      decisionStatus,
      input,
      measures,
      restrictions,
      additionalCodes,
      documentCodes,
      supplementaryUnits,
      dataVersion: datasetInfo.version || null,
      message: measures.length
        ? null
        : "Nessuna misura applicabile è disponibile nel database locale per i parametri indicati."
    };
  }
}

function uniqueByCode(items) {
  return Array.from(new Map(items.map(item => [item.code, item])).values());
}

function uniqueByUnit(items) {
  return Array.from(new Map(items.map(item => [
    `${item.code || ""}|${item.qualifier || ""}`,
    item
  ])).values());
}

function isRestriction(measure) {
  if (/supplementary\s+unit|unit[àa]\s+supplementare/i.test(String(measure.measure_type || ""))) return false;
  const text = [measure.measure_type, measure.description, measure.action, measure.duty]
    .filter(Boolean).join(" ").toLowerCase();
  return Boolean((measure.conditions || []).length || /controll|restri|proib|diviet|licen|autoriz|certificat/.test(text));
}

function measureDecisionStatus(measures, restrictions) {
  if (!measures.length) return "not_available";
  const text = restrictions.map(item => [item.measure_type, item.description, item.action].join(" ").toLowerCase()).join(" ");
  if (/proib|diviet/.test(text)) return "prohibited_or_exception_required";
  if (restrictions.length) return "conditions_to_verify";
  return "measures_available";
}

module.exports = { TaricMeasuresService, isRestriction, measureDecisionStatus };
