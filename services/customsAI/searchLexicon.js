"use strict";

const { normalizeText, uniqueStrings } = require("./textUtils");

const QUERY_EXPANSIONS = [
  { pattern: /\b(cellulare|telefonino|smart phone)\b/g, terms: ["smartphone", "telefono cellulare"] },
  { pattern: /\b(laptop|notebook|pc portatile)\b/g, terms: ["computer portatile", "macchina elaborazione informazione portatile"] },
  { pattern: /\b(t shirt|tshirt|maglietta)\b/g, terms: ["t-shirts", "magliette", "a maglia"] },
  { pattern: /\b(scarpa|scarpe|sneaker|sneakers)\b/g, terms: ["calzature"] },
  { pattern: /\b(bici)\b/g, terms: ["bicicletta", "velocipede"] },
  { pattern: /\b(matterello)\b/g, terms: ["mattarello"] },
  { pattern: /\b(gluten free)\b/g, terms: ["senza glutine"] },
  { pattern: /\b(tostato|tostata|tostati|tostate)\b/g, terms: ["torrefatto", "torrefatta"] }
];

const CODE_ALIASES = [
  {
    test: code => code === "2002101900",
    productTypes: ["pomodori pelati", "pomodoro pelato in scatola"],
    keywords: ["pelati", "lattina", "barattolo", "confezione fino a 1 kg", "600 g", "600gr"],
    synonyms: ["canned peeled tomatoes", "peeled tomatoes"]
  },
  {
    test: code => code === "2002101100",
    productTypes: ["pomodori pelati in grandi confezioni"],
    keywords: ["pelati", "confezione oltre 1 kg", "formato ristorazione"],
    synonyms: ["bulk canned peeled tomatoes"]
  },
  {
    test: code => code === "1902191090",
    productTypes: ["pasta senza glutine", "pasta alimentare non cotta non farcita"],
    keywords: ["gluten free", "senza frumento tenero", "senza farina di grano tenero"],
    synonyms: ["gluten-free pasta"]
  },
  {
    test: code => code === "1902191020",
    productTypes: ["pasta di riso senza glutine"],
    keywords: ["pasta contenente riso", "gluten free al riso"],
    synonyms: ["rice pasta"]
  },
  {
    test: code => code === "4419900000",
    productTypes: ["mattarello di legno", "utensile da cucina in legno"],
    keywords: ["mattarello", "matterello", "stendere impasto"],
    synonyms: ["wooden rolling pin", "rolling pin"]
  },
  {
    test: code => code === "3924100090",
    productTypes: ["mattarello di plastica", "mattarello di silicone", "utensile da cucina di plastica"],
    keywords: ["mattarello", "matterello", "stendere impasto", "silicone"],
    synonyms: ["plastic rolling pin", "silicone rolling pin"]
  },
  {
    test: code => code === "7323930090",
    productTypes: ["mattarello di acciaio", "utensile da cucina in acciaio inossidabile"],
    keywords: ["mattarello", "matterello", "inox", "stendere impasto"],
    synonyms: ["stainless steel rolling pin"]
  },
  {
    test: code => code === "3304990000",
    productTypes: ["crema cosmetica per il viso", "crema per la pelle"],
    keywords: ["crema viso", "skincare", "idratante", "cosmetico"],
    synonyms: ["face cream", "skin cream"]
  },
  {
    test: code => code === "8471300000",
    productTypes: ["computer portatile", "laptop", "notebook"],
    keywords: ["pc portatile", "computer con tastiera e schermo"],
    synonyms: ["portable computer"]
  },
  {
    test: code => code === "8517130000",
    productTypes: ["smartphone", "telefono cellulare"],
    keywords: ["cellulare", "telefonino", "telefono mobile"],
    synonyms: ["mobile phone", "smart phone"]
  },
  {
    test: code => code === "6109100010",
    productTypes: ["maglietta di cotone", "t-shirt di cotone"],
    keywords: ["tshirt", "t shirt", "maglia cotone"],
    synonyms: ["cotton t-shirt"]
  },
  {
    test: code => code === "0901210000",
    productTypes: ["caffè tostato", "caffè torrefatto"],
    keywords: ["caffe in grani tostato", "non decaffeinizzato"],
    synonyms: ["roasted coffee"]
  },
  {
    test: code => code === "0901220000",
    productTypes: ["caffè tostato decaffeinato", "caffè torrefatto decaffeinizzato"],
    keywords: ["decaffeinato", "decaf"],
    synonyms: ["decaffeinated roasted coffee"]
  },
  {
    test: code => code === "8711601000",
    productTypes: ["bicicletta elettrica a pedalata assistita", "e-bike fino a 250 W"],
    keywords: ["bici elettrica", "ebike", "pedelec"],
    synonyms: ["electric bicycle"]
  },
  {
    test: code => code === "8711609010",
    productTypes: ["bicicletta elettrica", "e-bike"],
    keywords: ["bici elettrica", "ebike", "motore elettrico ausiliario"],
    synonyms: ["electric bicycle"]
  }
];

const MATERIAL_PATTERNS = [
  ["acciaio inossidabile", /\b(acciai? inossidabili?|inox|stainless)\b/],
  ["acciaio", /\bacciai[oa]?\b/],
  ["alluminio", /\balluminio\b/],
  ["bambù", /\bbambu\b/],
  ["cotone", /\bcotone\b/],
  ["legno", /\blegn[oa]\b/],
  ["plastica", /\b(materie plastiche|plastica|plastic[oa])\b/],
  ["silicone", /\bsilicone\b/],
  ["vetro", /\bvetro\b/],
  ["lana", /\blana\b/],
  ["pelle", /\b(pelle|cuoio)\b/],
  ["riso", /\briso\b/]
];

function expandQuery(value) {
  const normalized = normalizeText(value);
  const additions = [];
  for (const rule of QUERY_EXPANSIONS) {
    rule.pattern.lastIndex = 0;
    if (rule.pattern.test(normalized)) additions.push(...rule.terms);
  }
  return uniqueStrings([value, ...additions], 240).join(" ");
}

function aliasesForRecord(code) {
  const matches = CODE_ALIASES.filter(rule => rule.test(code));
  return {
    productTypes: uniqueStrings(matches.flatMap(rule => rule.productTypes || []), 160),
    keywords: uniqueStrings(matches.flatMap(rule => rule.keywords || []), 160),
    synonyms: uniqueStrings(matches.flatMap(rule => rule.synonyms || []), 160)
  };
}

function inferMaterials(value) {
  const normalized = normalizeText(value);
  return MATERIAL_PATTERNS
    .filter(([, pattern]) => pattern.test(normalized))
    .map(([material]) => material);
}

module.exports = {
  expandQuery,
  aliasesForRecord,
  inferMaterials
};
