(function(){
  "use strict";

  var DISCLAIMER = "Indicazione di supporto: non sostituisce un'Informazione Tariffaria Vincolante (ITV/BTI) o la valutazione dell'autorità doganale.";
  var state = { busy:false };

  function byId(id){ return document.getElementById(id); }

  function element(tag, className, text){
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = String(text);
    return node;
  }

  function api(path){
    return typeof window.apiUrl === "function" ? window.apiUrl(path) : path;
  }

  function setMessage(text, type){
    var target = byId("customsAiMessage");
    if (!target) return;
    target.textContent = text || "";
    target.className = "customsAiMessage" + (text ? " is-visible is-" + (type || "info") : "");
  }

  function setBusy(busy){
    state.busy = busy;
    var button = byId("customsAiSubmit");
    var progress = byId("customsAiProgress");
    var shell = document.querySelector(".customsAiSearchShell");
    if (button) button.disabled = busy;
    if (progress) progress.classList.toggle("is-visible", busy);
    if (shell) shell.classList.toggle("is-busy", busy);
  }

  async function runClassification(description){
    if (state.busy) return;
    setMessage("");
    setBusy(true);
    try {
      var response = await fetch(api("/api/customs-ai/analyze"), {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers: { "Content-Type":"application/json", "Accept":"application/json" },
        body: JSON.stringify({ description:description, answers:{} })
      });
      var data = await response.json().catch(function(){ return null; });
      if (!response.ok || !data || !data.success) {
        throw new Error((data && data.error) || "Errore API (" + response.status + ")");
      }
      renderResponse(data);
    } catch (error) {
      renderEmpty();
      setMessage((error && error.message) || "DOGANA AI non è momentaneamente disponibile.", "error");
    } finally {
      setBusy(false);
    }
  }

  function renderResponse(data){
    var output = byId("customsAiOutput");
    if (!output) return;
    output.replaceChildren();

    if (data.status === "classified" && data.classification) {
      setMessage("");
      output.appendChild(renderInstantAnswer(data));
      return;
    }

    output.appendChild(renderNoResult(data));
  }

  function renderInstantAnswer(data){
    var classification = data.classification;
    var card = element("article", "customsAiAnswer");
    var top = element("div", "customsAiAnswerTop");
    var eyebrow = element("div", "customsAiAnswerEyebrow", "Risultato immediato");
    var confidence = element(
      "div",
      "customsAiAnswerConfidence",
      classification.confidence.percentage + "% compatibilità" + (classification.completeTaric === false ? " ramo" : "")
    );
    top.append(eyebrow, confidence);

    var intro = element("p", "customsAiAnswerIntro");
    intro.append(document.createTextNode("Per "));
    intro.appendChild(element("strong", "", cleanTitle(data.title || data.product && data.product.product || data.originalDescription)));
    intro.appendChild(document.createTextNode(
      classification.completeTaric === false
        ? ", il ramo HS/CN affidabile individuato è:"
        : ", la voce più compatibile disponibile è:"
    ));

    var codeRow = element("div", "customsAiCodeRow");
    var codeBlock = element("div", "customsAiCodeBlock");
    var codeLabel = classification.completeTaric === false
      ? "HS/CN individuato"
      : (classification.normativeVerified ? "TARIC proposto" : "TARIC da verificare");
    codeBlock.append(
      element("span", "customsAiCodeLabel", codeLabel),
      element("strong", "customsAiCode", formatTaric(classification.code))
    );
    var copyButton = element("button", "customsAiCopy", "Copia");
    copyButton.type = "button";
    copyButton.addEventListener("click", function(){ copyCode(classification.code, copyButton); });
    codeRow.append(codeBlock, copyButton);

    var fullDescription = cleanDatasetLabel(classification.officialDescription || classification.description);
    var description = element("p", "customsAiAnswerDescription", compactTaricDescription(fullDescription));
    description.title = fullDescription;

    card.append(top, intro, codeRow, description);

    var notes = Array.isArray(classification.resultNotes) ? classification.resultNotes : [];
    if (notes.length) {
      card.appendChild(element("p", "customsAiAnswerNote", notes[0]));
    }

    if (classification.nextQuestion) {
      var needed = element("div", "customsAiNeededDetails");
      needed.appendChild(element("strong", "", "Per completare la TARIC"));
      needed.appendChild(element("span", "", classification.nextQuestion));
      card.appendChild(needed);
    }

    var assumptions = Array.isArray(classification.assumptions) ? classification.assumptions : [];
    if (assumptions.length) {
      var assumption = element("div", "customsAiAssumption");
      assumption.appendChild(element("strong", "", "Ipotesi usata"));
      assumption.appendChild(element("span", "", assumptions.join(" ")));
      card.appendChild(assumption);
    }

    if (Array.isArray(data.alternatives) && data.alternatives.length) {
      card.appendChild(renderAlternatives(data.alternatives));
    }

    var footer = element("div", "customsAiAnswerFooter");
    var testData = data.dataset && data.dataset.status === "test";
    var sourceLabel = testData
      ? "TEST DATA · non usare in dichiarazione"
      : officialDatasetLabel(data.dataset);
    footer.append(
      element("span", testData ? "is-test" : "is-source", sourceLabel),
      element("span", "", DISCLAIMER)
    );
    card.appendChild(footer);
    return card;
  }

  function renderAlternatives(alternatives){
    var details = element("details", "customsAiAnswerAlternatives");
    details.appendChild(element("summary", "", "Vedi altre " + Math.min(alternatives.length, 3) + " possibilità"));
    alternatives.slice(0, 3).forEach(function(alternative){
      var row = element("div", "customsAiAnswerAlternative");
      var relative = Number.isFinite(alternative.relativePercentage)
        ? alternative.relativePercentage
        : alternative.percentage;
      row.append(
        element("strong", "", formatTaric(alternative.code)),
        element("span", "", cleanDatasetLabel(alternative.description)),
        element("small", "", relative + "%")
      );
      details.appendChild(row);
    });
    return details;
  }

  function renderNoResult(data){
    var card = element("article", "customsAiAnswer customsAiNoResult");
    card.appendChild(element("div", "customsAiAnswerEyebrow", "Ricerca completata"));
    card.appendChild(element("h3", "", "Codice non ancora disponibile nei dati locali"));
    card.appendChild(element(
      "p",
      "",
      data.message || "Prova ad aggiungere il tipo di prodotto o importa la nomenclatura TARIC completa."
    ));
    return card;
  }

  function renderEmpty(){
    var output = byId("customsAiOutput");
    if (output) output.replaceChildren();
  }

  async function copyCode(code, button){
    try {
      await navigator.clipboard.writeText(String(code || ""));
      button.textContent = "Copiato";
      setTimeout(function(){ button.textContent = "Copia"; }, 1200);
    } catch {
      setMessage("Copia non riuscita: seleziona il codice manualmente.", "warning");
    }
  }

  function cleanDatasetLabel(value){
    return String(value || "").replace(/^TEST DATA\s*[—-]\s*/i, "").trim();
  }

  function compactTaricDescription(value){
    var parts = String(value || "").split("›").map(function(part){ return part.trim(); }).filter(Boolean);
    var withoutChapter = parts.length > 2 && parts[0] === parts[0].toLocaleUpperCase("it-IT")
      ? parts.slice(1)
      : parts;
    if (withoutChapter.length <= 4) return withoutChapter.join(" → ");
    return [withoutChapter[0]].concat(withoutChapter.slice(-3)).join(" → ");
  }

  function cleanTitle(value){
    var text = String(value || "prodotto").trim().toLocaleLowerCase("it-IT");
    return text || "prodotto";
  }

  function officialDatasetLabel(dataset){
    var version = dataset && dataset.version && dataset.version.source_version;
    var count = Number(dataset && dataset.recordCount);
    var label = "TARIC UE ufficiale";
    if (version) label += " · " + version;
    if (Number.isFinite(count) && count > 0) label += " · " + count.toLocaleString("it-IT") + " voci";
    return label;
  }

  function formatTaric(value){
    var code = String(value || "").replace(/\D/g, "");
    if (code.length === 4) return code;
    if (code.length === 6) return code.slice(0, 4) + " " + code.slice(4);
    if (code.length === 8) return code.slice(0, 4) + " " + code.slice(4, 6) + " " + code.slice(6);
    if (code.length !== 10) return code;
    return code.slice(0, 4) + " " + code.slice(4, 6) + " " + code.slice(6, 8) + " " + code.slice(8);
  }

  function init(){
    var form = byId("customsAiForm");
    var input = byId("customsAiInput");
    if (!form || !input) return;
    form.addEventListener("submit", function(event){
      event.preventDefault();
      var description = input.value.trim();
      if (description.length < 2) {
        setMessage("Scrivi almeno due caratteri.", "warning");
        input.focus();
        return;
      }
      runClassification(description);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once:true });
  } else {
    init();
  }
})();
