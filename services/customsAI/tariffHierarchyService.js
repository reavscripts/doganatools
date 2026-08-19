"use strict";

const { LEVELS } = require("./constants");
const { normalizeCode } = require("./textUtils");

class TariffHierarchyService {
  constructor(repository) {
    this.repository = repository;
  }

  buildHierarchy(value) {
    const code = normalizeCode(value);
    if (code.length !== 10) return null;
    const tariffRecord = this.repository.findByCode(code);
    const result = {};
    for (const level of LEVELS) {
      const levelCode = code.slice(0, level.length);
      const record = this.repository.findByCode(levelCode);
      const embedded = tariffRecord?.hierarchy?.[level.key] || null;
      result[level.key] = {
        code: levelCode,
        level: level.label,
        name: level.name,
        description: embedded?.description || record?.description || null,
        source: tariffRecord?.source || record?.source || null
      };
    }
    return result;
  }

  validateHierarchy(value) {
    const hierarchy = this.buildHierarchy(value);
    if (!hierarchy) return { valid: false, errors: ["Il codice TARIC deve contenere 10 cifre."] };
    const errors = [];
    for (const level of LEVELS) {
      if (hierarchy[level.key].code.length !== level.length) {
        errors.push(`Livello ${level.name} non valido.`);
      }
    }
    return { valid: errors.length === 0, errors, hierarchy };
  }
}

module.exports = { TariffHierarchyService };
