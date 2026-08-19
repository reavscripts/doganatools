"use strict";

const fs = require("fs");
const path = require("path");

class ClassificationHistoryService {
  constructor(options = {}) {
    this.historyPath = options.historyPath || path.join(
      options.rootDir || path.resolve(__dirname, "../.."),
      "data",
      "customs",
      "history",
      "classifications.jsonl"
    );
    this.fs = options.fs || fs;
  }

  append(entry) {
    const safeEntry = removeSensitive({
      timestamp: new Date().toISOString(),
      ...entry
    });
    this.fs.mkdirSync(path.dirname(this.historyPath), { recursive: true });
    this.fs.appendFileSync(this.historyPath, `${JSON.stringify(safeEntry)}\n`, "utf8");
    return safeEntry.timestamp;
  }
}

function removeSensitive(value) {
  if (Array.isArray(value)) return value.map(removeSensitive);
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (/(api.?key|authorization|password|secret|token|cookie)/i.test(key)) continue;
    result[key] = removeSensitive(item);
  }
  return result;
}

module.exports = { ClassificationHistoryService, removeSensitive };
