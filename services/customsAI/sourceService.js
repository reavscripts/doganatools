"use strict";

const { SOURCE_TYPES } = require("./constants");

class SourceService {
  constructor(repository) {
    this.repository = repository;
  }

  getSources(record, datasetInfo) {
    const source = record?.source_id ? this.repository.getSourceById(record.source_id) : null;
    const available = source ? [{
      id: source.id,
      type: source.type,
      name: source.name,
      url: source.url || null,
      isOfficial: source.is_official === true,
      sourceVersion: record.source_version,
      retrievedAt: record.retrieved_at,
      notice: source.is_official === true ? null : "TEST DATA — fonte non normativa."
    }] : [];
    const covered = new Set(available.map(item => item.type));
    return {
      available,
      unavailable: SOURCE_TYPES.filter(type => !covered.has(type)).map(type => ({
        type,
        message: "Fonte non ancora disponibile nel database locale."
      })),
      normativeVerified: Boolean(datasetInfo?.isOfficial && available.some(item => item.isOfficial))
    };
  }
}

module.exports = { SourceService };
