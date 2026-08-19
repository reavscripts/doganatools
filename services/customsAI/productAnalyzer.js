"use strict";

const { normalizeText, sanitizeText, uniqueStrings } = require("./textUtils");

const MATERIALS = [
  ["acciaio inossidabile", ["acciaio inox", "inox", "stainless"]],
  ["acciaio", ["acciaio", "steel"]],
  ["bambù", ["bambu", "bamboo"]],
  ["legno", ["legno", "wood"]],
  ["plastica", ["plastica", "plastico", "plastic"]],
  ["silicone", ["silicone", "siliconico"]],
  ["marmo", ["marmo", "marble"]],
  ["alluminio", ["alluminio", "aluminium", "aluminum"]],
  ["vetro", ["vetro", "glass"]],
  ["cotone", ["cotone", "cotton"]],
  ["lana", ["lana", "wool"]]
];

class ProductAnalyzer {
  constructor(options = {}) {
    this.aiProvider = options.aiProvider;
    this.intentCache = new Map();
  }

  async analyze(description, answers = {}) {
    const normalized = normalizeText(description);
    const product = {
      product: detectProduct(normalized),
      material: detectMaterial(normalized),
      function: null,
      use: null,
      composition: detectComposition(description),
      dimensions: detectDimensions(description),
      power: detectPower(description),
      displacement: detectDisplacement(description),
      brand: null,
      model: null,
      additionalCharacteristics: detectCharacteristics(normalized),
      semanticTerms: [],
      excludedSemanticTerms: [],
      decisiveDetails: [],
      suggestedHs4Codes: []
    };

    applyKnownFunction(product, normalized);
    applyAnswers(product, answers);

    let aiWarning = null;
    if (this.aiProvider?.available) {
      try {
        const cacheKey = `${normalized}\u0000${JSON.stringify(answers || {})}`;
        let intent = this.intentCache.get(cacheKey);
        if (!intent) {
          intent = await this.aiProvider.analyzeSearchIntent(description, product);
          if (intent) {
            if (this.intentCache.size >= 200) this.intentCache.delete(this.intentCache.keys().next().value);
            this.intentCache.set(cacheKey, intent);
          }
        }
        applySemanticIntent(product, intent);
      } catch (error) {
        aiWarning = `Provider AI non disponibile: ${sanitizeText(error.message, 180)}`;
      }
    }

    const questions = buildQuestions(product, normalized, answers);
    return {
      product,
      questions,
      ai: {
        ...this.aiProvider?.getStatus?.(),
        warning: aiWarning
      }
    };
  }
}

function detectProduct(normalized) {
  const definitions = [
    ["pomodori pelati", ["pomodori pelati", "pomodoro pelato", "pelati in scatola", "peeled tomatoes"]],
    ["pasta senza glutine", ["pasta senza glutine", "pasta gluten free", "gluten free pasta"]],
    ["mattarello", ["mattarello", "matterello", "rolling pin"]],
    ["crema cosmetica", ["crema cosmetica", "crema viso", "crema per il viso", "skin cream"]],
    ["vite", ["vite", "viti", "screw"]],
    ["motoriduttore", ["motoriduttore", "motoriduttori", "gearmotor", "motor reducer"]],
    ["pasta alimentare", ["pasta alimentare", "pasta secca", "spaghetti", "maccheroni"]],
    ["tubo flessibile", ["tubo flessibile", "tubazione flessibile", "flexible hose"]],
    ["preparazione alimentare", ["preparazione alimentare", "crema al pistacchio", "preparato alimentare"]]
  ];
  for (const [name, aliases] of definitions) {
    if (aliases.some(alias => normalized.includes(normalizeText(alias)))) return name;
  }
  return normalized.split(" ").slice(0, 6).join(" ") || null;
}

function detectMaterial(normalized) {
  for (const [name, aliases] of MATERIALS) {
    if (aliases.some(alias => normalized.includes(normalizeText(alias)))) return name;
  }
  return null;
}

function detectComposition(description) {
  const matches = String(description).match(/\b\d{1,3}(?:[.,]\d+)?\s*%\s*[^,;.]+/g);
  return matches?.length ? matches.join("; ").slice(0, 300) : null;
}

function detectDimensions(description) {
  const match = String(description).match(/\b\d+(?:[.,]\d+)?\s*(?:mm|cm|m)\b(?:\s*[x×]\s*\d+(?:[.,]\d+)?\s*(?:mm|cm|m)\b)*/i);
  return match ? sanitizeText(match[0], 120) : null;
}

function detectPower(description) {
  const match = String(description).match(/\b\d+(?:[.,]\d+)?\s*(?:kw|w|cv|hp)\b/i);
  return match ? sanitizeText(match[0], 80) : null;
}

function detectDisplacement(description) {
  const text = String(description || "");
  const explicit = text.match(/\b\d+(?:[.,]\d+)?\s*(?:cm\s*[³3]|cc|cmc|litri?|l)\b/i);
  if (explicit) return sanitizeText(explicit[0], 80);
  const commonEngineSize = text.match(/\b([0-9](?:[.,][0-9]))\s+(?=(?:diesel|tdi|hdi|dci|jtd)\b)/i);
  return commonEngineSize ? `${commonEngineSize[1]} L` : null;
}

function detectCharacteristics(normalized) {
  const values = [];
  const map = [
    ["rinforzato", "rinforzato"],
    ["flessibile", "flessibile"],
    ["filettato", "filettato"],
    ["autofilettante", "autofilettante"],
    ["farcita", "farcita"],
    ["fresco", "fresco"],
    ["secco", "secco"],
    ["industriale", "uso industriale"],
    ["domestico", "uso domestico"]
  ];
  for (const [needle, value] of map) if (normalized.includes(needle)) values.push(value);
  return uniqueStrings(values);
}

function applyKnownFunction(product, normalized) {
  if (product.product === "mattarello") {
    product.function = "utensile da cucina";
    product.use = "preparazione alimenti";
  } else if (product.product === "crema cosmetica") {
    product.function = "cura della pelle";
    product.use = normalized.includes("viso") ? "viso" : null;
  } else if (product.product === "vite") {
    product.function = "elemento di fissaggio filettato";
    product.use = null;
  } else if (product.product === "motoriduttore") {
    product.function = "conversione elettromeccanica con riduzione";
    product.use = normalized.includes("cancello") ? "automazione cancello" : null;
  } else if (product.product === "pasta alimentare" || product.product === "pasta senza glutine") {
    product.function = "alimento a base di cereali";
    product.use = "alimentare";
  } else if (product.product === "pomodori pelati") {
    product.function = "ortaggio preparato o conservato";
    product.use = "alimentare";
  } else if (product.product === "tubo flessibile") {
    product.function = "convogliamento di fluidi";
  } else if (product.product === "preparazione alimentare") {
    product.function = "preparazione destinata all'alimentazione";
    product.use = "alimentare";
  }
}

function applyAnswers(product, answers) {
  const mapping = {
    material: "material",
    primary_material: "material",
    function: "function",
    main_function: "function",
    intended_use: "use",
    use: "use",
    composition: "composition",
    dimensions: "dimensions",
    power: "power",
    displacement: "displacement",
    engine_displacement: "displacement",
    brand: "brand",
    model: "model"
  };
  for (const [key, value] of Object.entries(answers || {})) {
    if (!value) continue;
    const target = mapping[key];
    if (target) product[target] = sanitizeText(value, 300) || null;
    else product.additionalCharacteristics.push(`${sanitizeText(key, 80)}: ${sanitizeText(value, 180)}`);
  }
  product.additionalCharacteristics = uniqueStrings(product.additionalCharacteristics);
}

function mergeMissingProductFields(product, patch) {
  if (!patch) return;
  for (const field of [
    "product", "material", "function", "use", "composition",
    "dimensions", "power", "displacement", "brand", "model"
  ]) {
    if (!product[field] && patch[field]) product[field] = patch[field];
  }
  product.additionalCharacteristics = uniqueStrings([
    ...product.additionalCharacteristics,
    ...(patch.additionalCharacteristics || [])
  ]);
}

function applySemanticIntent(product, intent) {
  if (!intent) return;
  if (intent.canonicalProduct) product.product = intent.canonicalProduct;
  if (intent.function) product.function = intent.function;
  if (intent.use) product.use = intent.use;
  product.semanticTerms = uniqueStrings(intent.officialSearchConcepts, 180).slice(0, 8);
  product.excludedSemanticTerms = uniqueStrings(intent.excludedCandidateConcepts, 180).slice(0, 8);
  product.decisiveDetails = uniqueStrings(intent.decisiveDetails, 180).slice(0, 6);
  product.suggestedHs4Codes = uniqueStrings(intent.suggestedHs4Codes, 12).slice(0, 3);
}

function buildQuestions(product, normalized, answers) {
  const questions = [];
  const hasAnswer = id => Boolean(answers?.[id]);
  const materialSensitiveProducts = new Set(["mattarello", "tubo flessibile"]);
  if (materialSensitiveProducts.has(product.product) && !product.material && !hasAnswer("material")) {
    questions.push(question(
      "material",
      "Qual è il materiale principale?",
      "Facoltativo: il materiale riordina le possibilità, senza nascondere automaticamente le altre.",
      ["Legno", "Bambù", "Plastica", "Silicone", "Acciaio", "Marmo", "Altro"],
      false
    ));
  }

  if (product.product === "crema cosmetica" && !product.use && !hasAnswer("intended_use")) {
    questions.push(question(
      "intended_use",
      "Qual è la funzione e la destinazione principale della crema?",
      "Cosmetici, preparazioni per capelli e prodotti con funzione terapeutica seguono voci differenti.",
      ["Viso / pelle", "Capelli", "Medicinale", "Altro"]
    ));
  }

  if (product.product === "vite" && !hasAnswer("thread_type") && !normalized.includes("autofilett")) {
    questions.push(question(
      "thread_type",
      "La vite è autofilettante o destinata al legno?",
      "Il tipo di filettatura è rilevante per distinguere le sottovoci.",
      ["Autofilettante", "Per legno", "Filettatura metrica", "Altro"]
    ));
  }

  if (product.product === "motoriduttore") {
    if (!product.power && !hasAnswer("power")) {
      questions.push(question(
        "power",
        "Qual è la potenza nominale del motore?",
        "La fascia di potenza può determinare la sottovoce.",
        ["Fino a 750 W", "Oltre 750 W fino a 75 kW", "Oltre 75 kW", "Non disponibile"]
      ));
    }
    if (!hasAnswer("motor_type")) {
      questions.push(question(
        "motor_type",
        "Che tipo di motore incorpora?",
        "Corrente continua, alternata monofase o polifase possono seguire sottovoci diverse.",
        ["Corrente continua", "AC monofase", "AC polifase", "Non disponibile"]
      ));
    }
  }

  if (product.product === "pasta alimentare" || product.product === "pasta senza glutine") {
    if (!hasAnswer("pasta_state")) {
      questions.push(question(
        "pasta_state",
        "La pasta è farcita, cotta oppure non cotta e non farcita?",
        "Lo stato del prodotto cambia la sottovoce.",
        ["Non cotta e non farcita", "Farcita", "Cotta", "Altro"]
      ));
    }
    if (!hasAnswer("contains_egg")) {
      questions.push(question(
        "contains_egg",
        "La pasta contiene uova?",
        "La presenza di uova può cambiare la classificazione CN/TARIC.",
        ["Sì", "No", "Non noto"]
      ));
    }
  }

  if (product.product === "preparazione alimentare" && !product.composition && !hasAnswer("composition")) {
    questions.push(question(
      "composition",
      "Indica gli ingredienti principali e le percentuali disponibili.",
      "Zucchero, latte, cacao e frutta a guscio possono cambiare la classificazione.",
      ["Inserisci composizione"]
    ));
  }

  return questions.slice(0, 4);
}

function question(id, text, reason, values, required = true) {
  return {
    id,
    text,
    reason,
    required,
    options: values.map(value => ({ label: value, value }))
  };
}

module.exports = {
  ProductAnalyzer,
  buildQuestions,
  detectMaterial,
  detectProduct,
  detectPower,
  detectDisplacement
};
