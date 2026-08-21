"use strict";

class TariffSearchService {
  constructor(repository) {
    this.repository = repository;
  }

  searchTariffCodes(query, product, options = {}) {
    return this.repository.searchTariffCodes(query, {
      product,
      classificationDate: options.classificationDate,
      limit: options.limit || 25,
      prefix: options.prefix
    });
  }

  semanticSearchTariffCodes(query, product, options = {}) {
    return this.repository.semanticSearchTariffCodes(query, product, options);
  }
}

module.exports = { TariffSearchService };
