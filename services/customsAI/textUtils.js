"use strict";

function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9%]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeText(value, maxLength = 2000) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function tokenize(value) {
  const stopWords = new Set([
    "a", "ad", "al", "alla", "alle", "con", "da", "dal", "dalla", "delle", "della",
    "dei", "del", "di", "e", "ed", "gli", "i", "il", "in", "la", "le", "lo", "o",
    "per", "un", "una", "uno", "the", "and", "for", "of", "to", "with"
  ]);
  return Array.from(new Set(
    normalizeText(value)
      .split(" ")
      .filter(token => token.length > 1 && !stopWords.has(token))
  ));
}

function stemSearchToken(value) {
  let token = normalizeText(value).replace(/\s+/g, "");
  if (token.length <= 4 || /\d/.test(token)) return token;
  token = token
    .replace(/(azioni|izioni|uzione|uzioni)$/i, "zion")
    .replace(/(amenti|amento|imenti|imento)$/i, "ment")
    .replace(/(atrice|atrici|atore|atori)$/i, "ator")
    .replace(/(iche|ichi|ica|ico)$/i, "ic")
    .replace(/(ose|osi|osa|oso)$/i, "os")
    .replace(/(ate|ati|ata|ato)$/i, "at")
    .replace(/(ute|uti|uta|uto)$/i, "ut")
    .replace(/(es)$/i, "")
    .replace(/(s)$/i, "")
    .replace(/[aeio]$/i, "");
  return token;
}

function tokenizeForSearch(value) {
  return Array.from(new Set(tokenize(value).map(stemSearchToken).filter(token => token.length > 1)));
}

function normalizeCode(value) {
  return String(value ?? "").replace(/\D/g, "").slice(0, 10);
}

function boundedNumber(value, min = 0, max = 1) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}

function uniqueStrings(values, maxLength = 160) {
  const result = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const clean = sanitizeText(value, maxLength);
    const key = normalizeText(clean);
    if (!clean || seen.has(key)) continue;
    seen.add(key);
    result.push(clean);
  }
  return result;
}

module.exports = {
  normalizeText,
  sanitizeText,
  tokenize,
  tokenizeForSearch,
  stemSearchToken,
  normalizeCode,
  boundedNumber,
  uniqueStrings
};
