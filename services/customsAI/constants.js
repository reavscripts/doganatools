"use strict";

const MODULE_VERSION = "0.2.0";
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_ANSWER_LENGTH = 500;
const MAX_ANSWERS = 30;

const LEVELS = Object.freeze([
  { key: "chapter", label: "HS", name: "Capitolo HS", length: 2 },
  { key: "hs4", label: "HS4", name: "Voce HS", length: 4 },
  { key: "hs6", label: "HS6", name: "Sottovoce HS", length: 6 },
  { key: "cn", label: "CN", name: "Codice CN", length: 8 },
  { key: "taric", label: "TARIC", name: "Codice TARIC", length: 10 }
]);

const SOURCE_TYPES = Object.freeze([
  "TARIC_UE",
  "CN",
  "HS",
  "SECTION_NOTE",
  "CHAPTER_NOTE",
  "HEADING_NOTE",
  "CN_EXPLANATORY_NOTE",
  "EU_CLASSIFICATION_REGULATION",
  "CLASS",
  "BTI",
  "OTHER_OFFICIAL"
]);

module.exports = {
  MODULE_VERSION,
  MAX_DESCRIPTION_LENGTH,
  MAX_ANSWER_LENGTH,
  MAX_ANSWERS,
  LEVELS,
  SOURCE_TYPES
};
