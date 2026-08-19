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
    const measures = this.repository.getMeasures(input.code, input.operationDate, input);
    return {
      status: measures.length ? "available" : "not_available",
      dataAvailable: measures.length > 0,
      input,
      measures,
      dataVersion: datasetInfo.version || null,
      message: measures.length
        ? null
        : "Nessuna misura applicabile è disponibile nel database locale per i parametri indicati."
    };
  }
}

module.exports = { TaricMeasuresService };
