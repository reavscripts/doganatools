"use strict";

const {
  MAX_DESCRIPTION_LENGTH,
  MAX_ANSWER_LENGTH,
  MAX_ANSWERS
} = require("./constants");
const { sanitizeText } = require("./textUtils");

class CustomsInputError extends Error {
  constructor(message, code = "INVALID_INPUT", statusCode = 400) {
    super(message);
    this.name = "CustomsInputError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function validateDescription(value) {
  if (typeof value !== "string") {
    throw new CustomsInputError("La descrizione della merce è obbligatoria.");
  }
  if (value.length > MAX_DESCRIPTION_LENGTH) {
    throw new CustomsInputError(
      `La descrizione non può superare ${MAX_DESCRIPTION_LENGTH} caratteri.`,
      "DESCRIPTION_TOO_LONG",
      413
    );
  }
  const description = sanitizeText(value, MAX_DESCRIPTION_LENGTH);
  if (description.length < 2) {
    throw new CustomsInputError("Descrivi la merce con almeno 2 caratteri.");
  }
  return description;
}

function validateAnswers(value) {
  if (value == null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CustomsInputError("Le risposte di approfondimento devono essere un oggetto.");
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_ANSWERS) {
    throw new CustomsInputError(`Sono ammesse al massimo ${MAX_ANSWERS} risposte.`);
  }
  return Object.fromEntries(entries.map(([rawKey, rawValue]) => {
    const key = sanitizeText(rawKey, 80).replace(/[^a-zA-Z0-9_]/g, "");
    if (!key) throw new CustomsInputError("Una risposta contiene un identificatore non valido.");
    if (!["string", "number", "boolean"].includes(typeof rawValue)) {
      throw new CustomsInputError(`La risposta ${key} non è valida.`);
    }
    const answer = sanitizeText(rawValue, MAX_ANSWER_LENGTH);
    return [key, answer];
  }));
}

function validateClassificationPayload(body = {}) {
  return {
    description: validateDescription(body.description),
    answers: validateAnswers(body.answers),
    classificationDate: validateDate(body.classificationDate)
  };
}

function validateDate(value) {
  if (!value) return new Date().toISOString().slice(0, 10);
  const clean = sanitizeText(value, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(clean) || Number.isNaN(Date.parse(`${clean}T00:00:00Z`))) {
    throw new CustomsInputError("La data di classificazione non è valida.");
  }
  return clean;
}

function validateMeasuresPayload(body = {}) {
  const code = String(body.code ?? "").replace(/\D/g, "");
  if (code.length !== 10) {
    throw new CustomsInputError("Per le misure è necessario un codice TARIC di 10 cifre.");
  }
  const flow = sanitizeText(body.flow || "import", 10).toLowerCase();
  if (!['import', 'export'].includes(flow)) {
    throw new CustomsInputError("Il flusso deve essere import oppure export.");
  }
  return {
    code,
    originCountry: sanitizeText(body.originCountry, 2).toUpperCase() || null,
    dispatchCountry: sanitizeText(body.dispatchCountry, 2).toUpperCase() || null,
    destinationCountry: sanitizeText(body.destinationCountry, 2).toUpperCase() || null,
    flow,
    operationDate: validateDate(body.operationDate)
  };
}

module.exports = {
  CustomsInputError,
  validateClassificationPayload,
  validateMeasuresPayload
};
