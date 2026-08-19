"use strict";

const { sanitizeText } = require("./textUtils");

const AIDA_BASE = "https://aidaonline7.adm.gov.it/nsitaric";

class AidaNomenclatureClient {
  constructor(options = {}) {
    this.fetch = options.fetch || global.fetch;
    this.userAgent = options.userAgent || "DoganaTools-TARIC-Updater/1.0";
    this.cookies = new Map();
    this.dataDate = null;
    this.delayMs = Number.isFinite(options.delayMs) ? options.delayMs : 100;
    if (typeof this.fetch !== "function") throw new Error("Fetch non disponibile per AIDA.");
  }

  async fetchItalianDescriptions(keys) {
    const wanted = new Set(Array.from(keys || []).map(String));
    if (!wanted.size) return new Map();
    const headingsByChapter = new Map();
    for (const key of wanted) {
      const digits = key.replace(/\D/g, "").slice(0, 10);
      if (digits.length !== 10) continue;
      const chapter = digits.slice(0, 2);
      const heading = digits.slice(0, 4);
      if (!headingsByChapter.has(chapter)) headingsByChapter.set(chapter, new Set());
      headingsByChapter.get(chapter).add(heading);
    }

    const cover = await this.request(`${AIDA_BASE}/TaricDispServlet`);
    this.dataDate = extractAidaDataDate(cover);
    const coverStack = extractVariable(cover, "stack");
    if (!coverStack) throw new Error("AIDA non ha restituito lo stato iniziale.");
    const index = await this.request(`${AIDA_BASE}/TaricServlet`, {
      method: "POST",
      form: { SC: "1", ST: "-2", UC: "1", Label: "8", "$STACK$": coverStack }
    });
    const indexStack = extractVariable(index, "st");
    if (!indexStack) throw new Error("AIDA non ha restituito lo stato dell'indice TARIC.");

    const result = new Map();
    for (const [chapter, headings] of headingsByChapter) {
      const chapterPage = await this.postIndexKey(indexStack, "-1", chapter);
      const chapterStack = extractVariable(chapterPage, "st");
      if (!chapterStack) continue;
      for (const heading of headings) {
        await delay(this.delayMs);
        const headingPage = await this.postIndexKey(chapterStack, "3", heading);
        for (const [key, description] of parseAidaNomenclatureRows(headingPage)) {
          if (wanted.has(key)) result.set(key, description);
        }
      }
    }
    return result;
  }

  postIndexKey(stack, state, code) {
    return this.request(`${AIDA_BASE}/NomenclatureImportServlet`, {
      method: "POST",
      form: {
        UC: "10",
        SC: "1",
        ST: state,
        Label: "102",
        "$STACK$": stack,
        "NomenclatureImport.SidNom": "",
        "NomenclatureImport.SidDes": "",
        "NomenclatureImport.SidTr": "",
        "NomenclatureImport.CodNc": code,
        "NomenclatureImport.CodTar": "",
        "NomenclatureImport.CodUc": "",
        "nomenclatureImport.InizioValiditaTrattini": "",
        "nomenclatureImport.InizioValiditaDescrizione": "",
        "NomenclatureImport.ValiditaDal": "",
        "NomenclatureImport.TipoNotaAss": "",
        "NomenclatureImport.CodiceNotaAss": "",
        "nomenclatureImport.InizioValiditaDescrizioneNotaAssociata": "",
        "NomenclatureImport.DataInizioAss": "",
        "nomenclatureImport.TipoGruppo": "",
        "NomenclatureImport.GruppoAppartenenza": ""
      }
    });
  }

  async request(url, options = {}) {
    const headers = {
      "User-Agent": this.userAgent,
      Accept: "text/html,application/xhtml+xml"
    };
    if (this.cookies.size) {
      headers.Cookie = Array.from(this.cookies, ([name, value]) => `${name}=${value}`).join("; ");
    }
    let body;
    if (options.form) {
      body = new URLSearchParams(options.form).toString();
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    }
    const response = await this.fetch(url, { method: options.method || "GET", headers, body });
    this.absorbCookies(response.headers);
    if (!response.ok) throw new Error(`AIDA non disponibile (${response.status}) per ${url}.`);
    return response.text();
  }

  absorbCookies(headers) {
    const values = typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : [headers.get("set-cookie")].filter(Boolean);
    for (const value of values) {
      const pair = String(value).split(";", 1)[0];
      const separator = pair.indexOf("=");
      if (separator > 0) this.cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
  }
}

function parseAidaNomenclatureRows(html) {
  const rows = new Map();
  const pattern = /linkToPostKey\(\s*['"]NomenclatureImportServlet['"]\s*,\s*15\s*,\s*1\s*,\s*['"]-1['"]\s*,\s*['"]102['"]\s*,\s*['"][^'"]*['"]\s*,\s*['"][^'"]*['"]\s*,\s*['"][^'"]*['"]\s*,\s*['"](\d{8})['"]\s*,\s*['"](\d{2})['"]\s*,\s*['"](\d{2})['"][^)]*\)[\s\S]*?<TD\s+class\s*=\s*TDOUTPUTSX\s+style\s*=\s*['"]border-width\s*:\s*0px['"]\s*>\s*([\s\S]*?)\s*<\/TD>/gi;
  for (const match of String(html || "").matchAll(pattern)) {
    const code = `${match[1]}${match[2]}`;
    const key = `${code} ${match[3]}`;
    const description = sanitizeText(decodeHtml(stripHtml(match[4])), 1000);
    if (description) rows.set(key, description);
  }
  return rows;
}

function extractVariable(html, name) {
  const match = String(html || "").match(new RegExp(`var\\s+${name}\\s*=\\s*["']([^"']+)["']`));
  return match?.[1] || null;
}

function extractAidaDataDate(html) {
  const match = String(html || "").match(/Dati\s+aggiornati\s+al\s*:\s*(\d{2})\/(\d{2})\/(\d{4})/i);
  return match ? `${match[3]}-${match[2]}-${match[1]}` : null;
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<br\s*\/?\s*>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

function delay(milliseconds) {
  return milliseconds > 0 ? new Promise(resolve => setTimeout(resolve, milliseconds)) : Promise.resolve();
}

module.exports = {
  AidaNomenclatureClient,
  parseAidaNomenclatureRows,
  extractVariable,
  extractAidaDataDate
};
