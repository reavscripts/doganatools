"use strict";

const express = require("express");
const fs = require("fs");
const path = require("path");
const { createCustomsAIRouter } = require("../routes/customsAI");

const rootDir = path.resolve(__dirname, "..");
const host = "127.0.0.1";
const port = Number(process.env.CUSTOMS_AI_PREVIEW_PORT || 4173);
const app = express();

app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});

// La build R10 verifica la sessione prima di mostrare l'interfaccia. Questa
// identità fittizia esiste soltanto nel processo di anteprima legato a 127.0.0.1;
// il server reale continua a usare cookie firmati e password.
const previewUser = {
  username: "preview-local",
  displayName: "Anteprima locale",
  role: "preview"
};
app.get("/api/auth/me", (req, res) => {
  res.json({ success: true, preview: true, user: previewUser });
});
app.post("/api/auth/login", (req, res) => {
  res.json({ success: true, preview: true, user: previewUser });
});
app.post("/api/auth/logout", (req, res) => {
  res.json({ success: true, preview: true });
});

app.use("/api/customs-ai", express.json({ limit: "64kb" }));
app.use("/api/customs-ai", createCustomsAIRouter({ rootDir }));

// L'anteprima espone soltanto gli asset pubblici necessari, mai data/, server.js
// o l'intera cartella di progetto.
app.use("/public", express.static(path.join(rootDir, "public"), { index: false }));
app.use("/img", express.static(path.join(rootDir, "img"), { index: false }));

app.get(["/", "/preview"], (req, res) => {
  const frontendPath = path.join(rootDir, "index.html");
  const html = fs.readFileSync(frontendPath, "utf8");
  const previewBanner = [
    '<div class="doganaPreviewBanner" role="status">',
    'ANTEPRIMA LOCALE DOGANA AI · Login disattivato soltanto su 127.0.0.1',
    '</div>'
  ].join("");
  const output = html.replace(/<body([^>]*)>/i, `<body$1>${previewBanner}`);
  res.type("html").send(output);
});

// Risposte vuote per evitare che i moduli esterni tentino operazioni reali durante
// l'anteprima. DOGANA AI usa invece il router completo montato sopra.
app.get(["/get-ships-sct", "/get-ships-conateco", "/get-ships-tfg"], (req, res) => {
  res.json({ success: true, preview: true, ships: [], allShips: [], count: 0, total: 0 });
});
app.get("/api/status", (req, res) => {
  res.json({ status: "OK", preview: true, message: "Anteprima locale DOGANA AI" });
});

// Stato locale vuoto per i moduli non oggetto della preview: evita avvisi e
// tentativi di riconnessione continui, senza leggere o modificare i dati reali.
app.get("/api/shared-state", (req, res) => {
  res.json({ success: true, preview: true, state: {} });
});
app.get("/api/extra-locks", (req, res) => {
  res.json({ success: true, preview: true, locks: [] });
});
app.get("/api/station-name", (req, res) => {
  res.json({ success: true, preview: true, stationName: "Anteprima locale" });
});
app.get("/api/operative-checklist", (req, res) => {
  res.json({ success: true, preview: true, state: { tasks: [] } });
});
app.get("/api/reminders", (req, res) => {
  res.json({ success: true, preview: true, state: { reminders: [], tasks: [] } });
});
app.get("/api/postits", (req, res) => {
  res.json({ success: true, preview: true, state: { notes: [] } });
});
app.get("/api/console", (req, res) => {
  res.json({ success: true, preview: true, lines: [], logs: [] });
});
app.get("/api/extra-events", (req, res) => {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  res.write(": preview locale\n\n");
  const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15000);
  req.on("close", () => clearInterval(heartbeat));
});

app.use((req, res) => {
  res.status(404).json({ success: false, preview: true, error: "Endpoint non disponibile nell'anteprima DOGANA AI." });
});

const server = app.listen(port, host, () => {
  console.log(`Anteprima DOGANA AI: http://${host}:${port}/preview`);
  console.log("Questa modalità è locale e non modifica il login del server normale.");
});

function closePreview(signal) {
  console.log(`Chiusura anteprima (${signal})...`);
  server.close(() => process.exit(0));
}

process.on("SIGINT", () => closePreview("SIGINT"));
process.on("SIGTERM", () => closePreview("SIGTERM"));
