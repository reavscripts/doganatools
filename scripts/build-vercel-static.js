"use strict";

const fs = require("node:fs");
const path = require("node:path");

const rootDir = path.resolve(__dirname, "..");
const outputDir = path.join(rootDir, "dist");

if (path.dirname(outputDir) !== rootDir || path.basename(outputDir) !== "dist") {
  throw new Error("Cartella di output Vercel non valida.");
}

const files = ["index.html", "UTILITYDOGANALISTA.html"];
const directories = ["img", "public"];

for (const relativePath of [...files, ...directories]) {
  const sourcePath = path.join(rootDir, relativePath);
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Risorsa frontend mancante: ${relativePath}`);
  }
}

fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(outputDir, { recursive: true });

for (const relativePath of files) {
  fs.copyFileSync(path.join(rootDir, relativePath), path.join(outputDir, relativePath));
}

for (const relativePath of directories) {
  fs.cpSync(path.join(rootDir, relativePath), path.join(outputDir, relativePath), {
    recursive: true
  });
}

console.log("Frontend Vercel preparato in dist/:");
console.log(`- ${files.join("\n- ")}`);
console.log(`- ${directories.map(name => `${name}/`).join("\n- ")}`);
