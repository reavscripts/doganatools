"use strict";

const path = require("node:path");
const { OfficialTaricImporter } = require("../services/customsAI/officialTaricImporter");

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    if (["dry-run", "force", "no-aida", "no-measures"].includes(key)) args[key] = true;
    else args[key] = argv[++index];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rootDir = path.resolve(__dirname, "..");
  const importer = new OfficialTaricImporter();
  const { report } = await importer.update({
    rootDir,
    targetPath: args.target ? path.resolve(rootDir, args.target) : undefined,
    cacheDir: args.cache ? path.resolve(rootDir, args.cache) : undefined,
    year: args.year,
    month: args.month,
    dryRun: args["dry-run"] === true,
    force: args.force === true,
    aida: args["no-aida"] !== true,
    measures: args["no-measures"] !== true,
    onProgress(message) {
      console.error(`[TARIC] ${message}…`);
    }
  });
  console.log(JSON.stringify(report, null, 2));
}

main().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
