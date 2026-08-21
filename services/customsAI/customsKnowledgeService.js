"use strict";

const { normalizeText } = require("./textUtils");

const SOURCES = Object.freeze({
  classification: "https://taxation-customs.ec.europa.eu/customs/common-customs-tariff-cct/tariff-classification-goods_en",
  nomenclature: "https://taxation-customs.ec.europa.eu/customs/common-customs-tariff-cct/tariff-classification-goods/combined-nomenclature_en",
  bti: "https://taxation-customs.ec.europa.eu/online-services/online-services-and-databases-customs/european-binding-tariff-information-ebti_en"
});

class CustomsKnowledgeService {
  answer(value) {
    const query = normalizeText(value);
    if (!looksLikeQuestion(value, query)) return null;

    if (/(?:differenza|differiscono).*(?:hs|cn|taric)|(?:hs|cn).*(?:taric|differenza)/.test(query)) {
      return response(
        "Differenza tra HS, CN e TARIC",
        "Sono livelli successivi della stessa classificazione merceologica.",
        [
          "HS: 6 cifre, sistema internazionale armonizzato.",
          "CN: 8 cifre, dettaglio usato nell'Unione europea.",
          "TARIC: 10 cifre, aggiunge le suddivisioni necessarie per applicare le misure UE."
        ],
        SOURCES.nomenclature
      );
    }

    if (/(?:quante|numero).*(?:cifre|digit).*(?:taric|codice)|(?:taric).*(?:quante|cifre|digit)/.test(query)) {
      return response(
        "Quante cifre ha un codice TARIC?",
        "Il codice TARIC dichiarabile ha 10 cifre: le prime 8 formano il codice CN, la nona e la decima individuano la sottovoce TARIC.",
        ["2 cifre: capitolo HS", "4 cifre: voce HS", "6 cifre: sottovoce HS", "8 cifre: CN", "10 cifre: TARIC"],
        SOURCES.nomenclature
      );
    }

    if (/\b(?:itv|bti|informazione tariffaria vincolante)\b/.test(query)) {
      return response(
        "Che cos'è un'ITV / BTI?",
        "È una decisione legale dell'autorità doganale sulla classificazione tariffaria di uno specifico prodotto.",
        [
          "In genere è valida per 3 anni in tutta l'Unione europea.",
          "Vincola le amministrazioni doganali e il titolare della decisione.",
          "È lo strumento adatto quando serve certezza giuridica sul codice."
        ],
        SOURCES.bti
      );
    }

    if (/(?:cos e|cosa significa|che cosa e|definizione).*(?:taric)|\btaric\s+(?:cos e|significa cosa)/.test(query)) {
      return response(
        "Che cos'è la TARIC?",
        "La TARIC è la tariffa integrata dell'Unione europea: parte dalla Nomenclatura Combinata e collega alle merci le suddivisioni e le misure applicabili agli scambi con Paesi extra UE.",
        [
          "Il codice TARIC arriva a 10 cifre.",
          "Può determinare dazi, preferenze, sospensioni, contingenti e altre misure.",
          "IVA e altre imposte nazionali non fanno parte della banca dati TARIC UE."
        ],
        SOURCES.classification
      );
    }

    if (/(?:come|modo).*(?:trova|trovare|individua|classifica).*(?:taric|codice doganale)|(?:taric|codice doganale).*(?:come|trovare)/.test(query)) {
      return response(
        "Come si individua il codice corretto?",
        "Si parte dal bene realmente importato, poi si scende nella gerarchia confrontando descrizioni, note di sezione e capitolo e regole generali di classificazione.",
        [
          "Servono composizione, funzione, stato del prodotto e uso principale.",
          "Peso, potenza, dimensioni o confezionamento vanno chiesti soltanto se separano le sottovoci candidate.",
          "Per i casi dubbi si controllano note esplicative, regolamenti di classificazione, precedenti BTI e, se necessario, si richiede un'ITV."
        ],
        SOURCES.classification
      );
    }

    if (/(?:posso|sicuro|certezza|affidabile).*(?:usare|dichiarazione|codice|taric)|(?:risultato|codice).*(?:vincolante|sicuro)/.test(query)) {
      return response(
        "Il risultato di DOGANA AI è vincolante?",
        "No. È un supporto operativo che restringe i candidati e segnala i dati mancanti; la certezza giuridica deriva da un'ITV / BTI o dalla valutazione dell'autorità doganale.",
        ["Controlla sempre descrizione ufficiale, note e misure alla data dell'operazione."],
        SOURCES.bti
      );
    }

    return null;
  }
}

function looksLikeQuestion(raw, normalized) {
  if (String(raw || "").includes("?")) return true;
  return /^(?:che cosa|cosa|cos e|come|quale|quali|quante|perche|posso|a cosa serve|differenza)\b/.test(normalized);
}

function response(title, text, bullets, sourceUrl) {
  return {
    title,
    text,
    bullets,
    source: {
      label: "Approfondisci sulla Commissione europea",
      url: sourceUrl
    },
    followUp: "Se invece vuoi classificare una merce, scrivi direttamente il nome del prodotto e i dettagli che conosci."
  };
}

module.exports = { CustomsKnowledgeService, looksLikeQuestion };
