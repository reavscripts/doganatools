"use strict";

const path = require("path");
const { CustomsDataImporter } = require("../services/customsAI/customsDataImporter");

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    if (["official", "dry-run"].includes(key)) result[key] = true;
    else result[key] = argv[index + 1], index += 1;
  }
  return result;
}

function usage() {
  return [
    "Uso:",
    "  npm run import-customs-data -- --source <file.json|file.csv> --source-name <fonte> --source-version <versione> [opzioni]",
    "",
    "Opzioni:",
    "  --target <file>       destinazione (default data/customs/processed/customs-dataset.json)",
    "  --valid-from YYYY-MM-DD",
    "  --valid-to YYYY-MM-DD",
    "  --official            marca la fonte come ufficiale solo dopo verifica umana",
    "  --dry-run             valida e produce il report senza scrivere"
  ].join("\n");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.source) {
    console.error(usage());
    process.exitCode = 1;
    return;
  }
  const rootDir = path.resolve(__dirname, "..");
  const importer = new CustomsDataImporter();
  const { report } = importer.importFile({
    sourcePath: path.resolve(rootDir, args.source),
    targetPath: args.target
      ? path.resolve(rootDir, args.target)
      : path.join(rootDir, "data", "customs", "processed", "customs-dataset.json"),
    source: args["source-name"],
    sourceVersion: args["source-version"],
    validFrom: args["valid-from"],
    validTo: args["valid-to"],
    official: args.official === true,
    dryRun: args["dry-run"] === true
  });
  console.log(JSON.stringify(report, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error?.stack || error);
  process.exitCode = 1;
}
