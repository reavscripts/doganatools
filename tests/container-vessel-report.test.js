"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
// server.js è escluso da Git e viene distribuito separatamente dal frontend.
const backend = fs.existsSync(path.join(root, "server.js"))
  ? fs.readFileSync(path.join(root, "server.js"), "utf8") : null;
const backendTest = (name, fn) => test(name, {skip:!backend && "server.js non presente in questo checkout"}, fn);
const frontend = fs.readFileSync(path.join(root, "index.html"), "utf8");

// Isola gli handler reali senza avviare server, login, browser o timer operativi.
function section(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `Sezione mancante: ${start}`);
  return source.slice(from, to);
}

async function requestReport(data, {entered = false, ok = true} = {}) {
  let handler;
  let corsMiddleware;
  let evaluations = 0;
  let downloads = 0;
  const context = vm.createContext({
    app: {get(route, callback) { handler = callback; }, use(callback) { corsMiddleware = callback; }},
    DOGANA_FRONTEND_ORIGIN:"https://dogana.reav.website",
    readLocalContainerVesselReport: () => null,
    pdfCache: new Map(), loadDiskCache: () => null, PDF_CACHE_TTL_MS: 1,
    ensureJmtSession: async () => ({evaluate: async () => ++evaluations <= 3
      ? {ok:true, text:"{}"} : {ok, text:JSON.stringify(data)}}),
    JMT_REPORT_ID:"memorandum", JMT_REPORT_NAME:"Web Visto Entrare",
    JMT_REPORTS_URL:"/reports", JMT_REPORT_RUN_URL:"/run",
    assertJmtResponseSession(text) {
      if (JSON.parse(text)?.Errors?.some(error => String(error.Code) === "-999")) {
        throw Object.assign(new Error("Sessione JMT disconnessa"), {sessionExpired:true});
      }
    },
    sendJmtCooldownResponse(res, error) {
      if (!error.sessionExpired) return false;
      res.status(429).json({success:false, sessionExpired:true, error:error.message});
      return true;
    },
    fetchPdfBufferFromJmtSession: async () => { downloads++; return {buffer:Buffer.from("%PDF-test")}; },
    fetchPublicSctPdf: async () => { downloads++; return {buffer:Buffer.from("%PDF-test")}; },
    saveCachedPdfFile: () => {},
    buildContainerVesselPayload: (container, entered, buffer, pdfUrl) => ({success:true, pdfUrl, pdfBase64:buffer.toString("base64")}),
    jmtBusy:Promise.resolve(), URL
  });
  vm.runInContext(section(backend, "function doganaOriginMatchesRequest(", "// DOGANA AI accetta soltanto"), context);
  vm.runInContext(section(backend, "const containerVesselReports = new Map();", 'app.get(["/get-pdf"'), context);
  const res = {statusCode:200, headers:{}, setHeader(name, value) { this.headers[name]=value; }, status(value) { this.statusCode=value; return this; }, json(value) { this.body=value; return this; }};
  const req = {method:"GET", headers:{origin:"https://dogana.reav.website"}, query:{container:"SLEU4959160", entered:entered ? "1" : "0"}};
  let allowed = false;
  corsMiddleware(req, res, () => { allowed=true; });
  if (allowed) await handler(req, res);
  return {status:res.statusCode, body:res.body, headers:res.headers, downloads};
}

for (const entered of [false, true]) {
  backendTest(`JMT 81044 è un esito senza risultati (${entered ? "memorandum" : "posizionamento"})`, async () => {
    const result = await requestReport({Errors:[{Code:"81044", Message:" Nessun risultato per la selezione corrente."}], Warnings:[], Data:null}, {entered});
    assert.equal(result.status, 200);
    assert.equal(result.body.success, true);
    assert.equal(result.body.found, false);
    assert.equal(result.body.code, "JMT_REPORT_NOT_FOUND");
    assert.equal(result.downloads, 0);
  });
}

backendTest("Report vuoto senza Errors restituisce lo stesso esito negativo", async () => {
  const result = await requestReport({Errors:null, Data:null});
  assert.equal(result.status, 200);
  assert.equal(result.body.found, false);
});

backendTest("Un report disponibile continua a essere scaricato", async () => {
  const result = await requestReport({Errors:null, Data:"/downloads/report.pdf"});
  assert.equal(result.status, 200);
  assert.equal(result.body.success, true);
  assert.equal(result.downloads, 1);
  assert.equal(result.body.pdfUrl, "https://jmt.salernocontainerterminal.com/downloads/report.pdf");
});

backendTest("81044 non nasconde errori tecnici o permessi mancanti", async () => {
  for (const [code, status] of [["83106", 403], ["12345", 502]]) {
    const result = await requestReport({Errors:[{Code:"81044"}, {Code:code, Message:"Errore effettivo"}], Data:null});
    assert.equal(result.status, status);
    assert.equal(result.body.success, false);
    assert.equal(result.downloads, 0);
  }
  const httpError = await requestReport({Errors:[{Code:"81044"}], Data:null}, {ok:false});
  assert.equal(httpError.status, 502);
});

backendTest("La sessione JMT scaduta mantiene il cooldown", async () => {
  const result = await requestReport({Errors:[{Code:"-999", Message:"Fatal error"}], Data:null});
  assert.equal(result.status, 429);
  assert.equal(result.body.sessionExpired, true);
});

backendTest("Il report conserva CORS anche per risultati vuoti, sessione scaduta ed errori", async () => {
  for (const code of ["81044", "83106", "-999", "12345"]) {
    const result = await requestReport({Errors:[{Code:code, Message:"Risposta JMT"}], Data:null});
    assert.equal(result.headers["Access-Control-Allow-Origin"], "https://dogana.reav.website");
    assert.equal(result.headers["Access-Control-Allow-Credentials"], "true");
    assert.equal(result.headers["Vary"], "Origin");
  }
});

function createFrontend(fetch) {
  const messages = [];
  const timers = [];
  let pdfReads = 0;
  const context = vm.createContext({
    fetch, apiUrl:value => value,
    extraReadVesselPdf:async () => { pdfReads++; return {name:"NAVE TEST"}; },
    EXTRA_TERMINALS:{sct:{containerField:"sct", statusField:"sctStatus", label:"SCT"}},
    extraVesselKey:value => String(value || "").toUpperCase(),
    extraVesselCache:new Map(), readExtraVesselPersistent:() => null,
    writeExtraVesselPersistent() {},
    renderDoganaMessage:(td, message, tone) => messages.push({message, tone}),
    renderDoganaError:(td, error) => messages.push({message:error.message, tone:"error"}),
    setTimeout:callback => timers.push(callback)
  });
  vm.runInContext(section(frontend, "    async function loadExtraSctVesselReport(", "    function refreshExtraPriorityButtons("), context);
  return {context, messages, pdfReads:() => pdfReads, async paint() {
    context.renderExtraVesselCell({dataset:{}, isConnected:true}, {sct:"SLEU4959160", sctStatus:"NON TROVATO"}, "sct");
    timers.shift()();
    await new Promise(setImmediate);
  }};
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {status, headers:{"Content-Type":"application/json"}});
}

test("Il frontend mostra l'esito vuoto come avviso e non tenta di leggere un PDF", async () => {
  const ui = createFrontend(async () => jsonResponse({success:true, found:false, code:"JMT_REPORT_NOT_FOUND"}));
  await ui.paint();
  assert.deepEqual(ui.messages.at(-1), {tone:"warning", message:"Nessun risultato nel posizionamento doganale SCT"});
  assert.equal(ui.pdfReads(), 0);
  assert.ok(ui.context.extraVesselCache.get("sct:SLEU4959160:false").until <= Date.now()+60000);
});

test("Il frontend riconosce anche le risposte dei backend precedenti", async () => {
  for (const [status, error] of [[404, "Report nave non trovato"], [502, " Nessun risultato per la selezione corrente."]]) {
    const ui = createFrontend(async () => jsonResponse({success:false, error}, status));
    await ui.paint();
    assert.equal(ui.messages.at(-1).tone, "warning");
    assert.match(ui.messages.at(-1).message, /^Nessun risultato/);
  }
});

test("Errori di rete, sessione, cache e risposta non JSON non diventano risultati vuoti", async () => {
  for (const fetch of [
    async () => { throw new TypeError("Failed to fetch"); },
    async () => jsonResponse({success:false, sessionExpired:true, error:"Sessione JMT disconnessa"}, 429),
    async () => jsonResponse({success:false, error:"Utente senza permesso"}, 403),
    async () => jsonResponse({success:false, error:"Memorandum non disponibile in cache. La sessione JMT è disconnessa."}, 404),
    async () => new Response("<html>Gateway timeout</html>", {status:504})
  ]) {
    const ui = createFrontend(fetch);
    await ui.paint();
    assert.equal(ui.messages.at(-1).tone, "error");
    assert.doesNotMatch(ui.messages.at(-1).message, /^Nessun risultato/);
  }
});

test("Il frontend conserva dati e parametri del memorandum disponibile", async () => {
  let requested;
  const ui = createFrontend(async url => {
    requested = url;
    return jsonResponse({success:true, pdfBase64:"JVBERg==", source:"Memorandum ingresso SCT", pdfUrl:"/report.pdf"});
  });
  const result = await ui.context.loadExtraSctVesselReport("SLEU4959160", true, true, true);
  assert.match(requested, /entered=1&cacheOnly=1&refresh=1$/);
  assert.equal(result.name, "NAVE TEST");
  assert.equal(result.source, "Memorandum ingresso SCT");
  assert.equal(ui.pdfReads(), 1);
});
