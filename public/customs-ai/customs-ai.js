(function(){
  "use strict";

  var DISCLAIMER = "Indicazione di supporto: non sostituisce un'Informazione Tariffaria Vincolante (ITV/BTI) o la valutazione dell'autorità doganale.";
  var state = {
    busy:false,
    originalDescription:"",
    answers:{},
    activeQuestion:null,
    lastResponse:null
  };

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

  function setBusy(busy, continuation){
    state.busy = busy;
    var button = byId("customsAiSubmit");
    var progress = byId("customsAiProgress");
    var progressLabel = byId("customsAiProgressLabel");
    var shell = document.querySelector(".customsAiSearchShell");
    if (button) button.disabled = busy;
    if (progress) progress.classList.toggle("is-visible", busy);
    if (progressLabel) {
      progressLabel.textContent = continuation
        ? "Aggiorno la classificazione con il nuovo dettaglio…"
        : "Individuo la famiglia merceologica e confronto le sottovoci…";
    }
    if (shell) shell.classList.toggle("is-busy", busy);
    document.querySelectorAll(".customsAiClarification button, .customsAiClarification input").forEach(function(control){
      control.disabled = busy;
    });
  }

  async function runClassification(description, options){
    options = options || {};
    if (state.busy) return;
    if (!options.continuation) {
      state.originalDescription = description;
      state.answers = {};
      state.activeQuestion = null;
    }
    setMessage("");
    setBusy(true, options.continuation);
    try {
      var response = await fetch(api("/api/customs-ai/analyze"), {
        method:"POST",
        credentials:"include",
        cache:"no-store",
        headers:{ "Content-Type":"application/json", "Accept":"application/json" },
        body:JSON.stringify({
          description:state.originalDescription || description,
          answers:state.answers
        })
      });
      var data = await response.json().catch(function(){ return null; });
      if (!response.ok || !data || !data.success) {
        throw new Error((data && data.error) || "Errore API (" + response.status + ")");
      }
      state.lastResponse = data;
      state.activeQuestion = data.clarification && data.clarification.activeQuestion || null;
      renderResponse(data);
    } catch (error) {
      renderEmpty();
      setMessage((error && error.message) || "DOGANA AI non è momentaneamente disponibile.", "error");
    } finally {
      setBusy(false, options.continuation);
    }
  }

  function answerQuestion(question, value){
    var clean = String(value || "").trim();
    if (!question || !question.id || !clean || state.busy) return;
    state.answers[question.id] = clean;
    runClassification(state.originalDescription, { continuation:true });
  }

  function renderResponse(data){
    var output = byId("customsAiOutput");
    if (!output) return;
    output.replaceChildren();

    if (data.status === "answered" && data.answer) {
      setMessage("");
      output.appendChild(renderKnowledgeAnswer(data.answer));
      return;
    }

    if (data.status === "classified" && data.classification) {
      setMessage("");
      output.appendChild(renderInstantAnswer(data));
      return;
    }

    output.appendChild(renderNoResult(data));
  }

  function renderInstantAnswer(data){
    var classification = data.classification;
    var clarification = data.clarification || {};
    var card = element("article", "customsAiAnswer");
    var top = element("div", "customsAiAnswerTop");
    var eyebrowText = classification.decisionStatus === "complete"
      ? "Ricerca completata"
      : (classification.decisionStatus === "branch" ? "Famiglia individuata" : "Risultato provvisorio");
    var eyebrow = element("div", "customsAiAnswerEyebrow", eyebrowText);
    var confidenceText = classification.confidence.percentage + "% compatibilità stimata";
    if (classification.completeTaric === false && String(classification.code || "").length < 10) confidenceText += " ramo";
    var confidence = element("div", "customsAiAnswerConfidence", confidenceText);
    top.append(eyebrow, confidence);

    var intro = element("p", "customsAiAnswerIntro");
    intro.append(document.createTextNode("Per "));
    intro.appendChild(element("strong", "", cleanTitle(data.title || data.product && data.product.product || data.originalDescription)));
    intro.appendChild(document.createTextNode(introSuffix(classification)));

    var codeRow = element("div", "customsAiCodeRow");
    var codeBlock = element("div", "customsAiCodeBlock");
    codeBlock.append(
      element("span", "customsAiCodeLabel", codeLabel(classification)),
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
    if (notes.length) card.appendChild(element("p", "customsAiAnswerNote", notes[0]));

    if (clarification.answeredDetails && clarification.answeredDetails.length) {
      card.appendChild(renderAnsweredDetails(clarification.answeredDetails));
    }

    if (clarification.activeQuestion) {
      card.appendChild(renderClarification(clarification.activeQuestion));
    } else if (clarification.unresolvedAnswers && clarification.unresolvedAnswers.length) {
      var unresolved = element("div", "customsAiUnresolved");
      unresolved.append(
        element("strong", "", "Risultato ancora provvisorio"),
        element("span", "", "Un dato decisivo non è disponibile. Il codice resta il miglior candidato, non una voce verificata in modo completo.")
      );
      card.appendChild(unresolved);
    }

    if (Array.isArray(data.alternatives) && data.alternatives.length) {
      card.appendChild(renderAlternatives(data.alternatives));
    }

    if (String(classification.code || "").replace(/\D/g, "").length >= 8) {
      card.appendChild(renderMeasuresLookup(classification.code, data.classificationDate));
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

  function renderClarification(question){
    var section = element("section", "customsAiClarification");
    var header = element("div", "customsAiClarificationHeader");
    header.append(
      element("span", "customsAiClarificationSpark", "✦"),
      element("strong", "", "Mi serve un dettaglio")
    );
    section.append(
      header,
      element("h3", "", question.text),
      element("p", "customsAiClarificationReason", question.reason)
    );

    if (Array.isArray(question.options) && question.options.length) {
      var choices = element("div", "customsAiQuickAnswers");
      question.options.forEach(function(option){
        var button = element("button", "customsAiQuickAnswer", option.label);
        button.type = "button";
        button.addEventListener("click", function(){ answerQuestion(question, option.value); });
        choices.appendChild(button);
      });
      section.appendChild(choices);
    }

    var form = element("form", "customsAiFollowUp");
    var input = element("input", "customsAiFollowUpInput");
    input.type = "text";
    input.maxLength = 500;
    input.placeholder = question.placeholder || "Scrivi la risposta";
    input.setAttribute("aria-label", question.text);
    var submit = element("button", "customsAiFollowUpSubmit", "Invia");
    submit.type = "submit";
    form.append(input, submit);
    form.addEventListener("submit", function(event){
      event.preventDefault();
      if (!input.value.trim()) {
        input.focus();
        return;
      }
      answerQuestion(question, input.value);
    });
    section.appendChild(form);

    var unknown = element("button", "customsAiUnknown", "Non ho questo dato");
    unknown.type = "button";
    unknown.addEventListener("click", function(){ answerQuestion(question, "Non disponibile"); });
    section.appendChild(unknown);
    return section;
  }

  function renderAnsweredDetails(details){
    var wrap = element("div", "customsAiAnsweredDetails");
    wrap.appendChild(element("span", "", "Dettagli considerati"));
    details.slice(0, 5).forEach(function(detail){
      wrap.appendChild(element("strong", "", detail.value));
    });
    return wrap;
  }

  function renderKnowledgeAnswer(answer){
    var card = element("article", "customsAiAnswer customsAiKnowledge");
    card.appendChild(element("div", "customsAiAnswerEyebrow", "Risposta DOGANA AI"));
    card.appendChild(element("h3", "", answer.title));
    card.appendChild(element("p", "customsAiKnowledgeText", answer.text));
    if (Array.isArray(answer.bullets) && answer.bullets.length) {
      var list = element("ul", "customsAiKnowledgeList");
      answer.bullets.forEach(function(item){ list.appendChild(element("li", "", item)); });
      card.appendChild(list);
    }
    if (answer.followUp) card.appendChild(element("p", "customsAiKnowledgeFollowUp", answer.followUp));
    if (answer.source && answer.source.url) {
      var link = element("a", "customsAiKnowledgeSource", answer.source.label || "Fonte ufficiale");
      link.href = answer.source.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      card.appendChild(link);
    }
    return card;
  }

  function introSuffix(classification){
    if (classification.decisionStatus === "branch") return ", la famiglia HS/CN affidabile individuata è:";
    if (classification.decisionStatus === "provisional") return ", il miglior candidato attuale è:";
    return ", la voce più compatibile disponibile è:";
  }

  function codeLabel(classification){
    if (classification.decisionStatus === "branch") return "HS/CN individuato";
    if (classification.decisionStatus === "provisional") return "TARIC provvisorio";
    return classification.normativeVerified ? "TARIC proposto" : "TARIC da verificare";
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

  function renderMeasuresLookup(code, classificationDate){
    var section = element("section", "customsAiMeasures");
    var heading = element("div", "customsAiMeasuresHeading");
    heading.append(
      element("strong", "", "Misure import/export per paese"),
      element("span", "", "Restrizioni, documenti e codici addizionali dalla banca dati TARIC")
    );
    var form = element("form", "customsAiMeasuresForm");
    var flow = element("select", "customsAiMeasuresField");
    flow.setAttribute("aria-label", "Flusso doganale");
    [["export", "Esportazione"], ["import", "Importazione"]].forEach(function(item){
      var option = element("option", "", item[1]);
      option.value = item[0];
      flow.appendChild(option);
    });
    var country = element("input", "customsAiMeasuresField");
    country.type = "text";
    country.maxLength = 2;
    country.placeholder = "Paese (es. US)";
    country.setAttribute("aria-label", "Codice ISO del paese");
    country.autocapitalize = "characters";
    var date = element("input", "customsAiMeasuresField");
    date.type = "date";
    date.value = classificationDate || new Date().toISOString().slice(0, 10);
    date.setAttribute("aria-label", "Data operazione");
    var additional = element("input", "customsAiMeasuresField");
    additional.type = "text";
    additional.maxLength = 4;
    additional.placeholder = "Cod. addizionale";
    additional.setAttribute("aria-label", "Codice addizionale comunitario opzionale");
    additional.autocapitalize = "characters";
    var submit = element("button", "customsAiMeasuresSubmit", "Verifica misure");
    submit.type = "submit";
    form.append(flow, country, date, additional, submit);
    var output = element("div", "customsAiMeasuresOutput");
    form.addEventListener("submit", function(event){
      event.preventDefault();
      var countryCode = country.value.trim().toUpperCase();
      if (!/^[A-Z]{2}$/.test(countryCode)) {
        output.replaceChildren(element("p", "customsAiMeasuresError", "Inserisci un codice paese ISO a 2 lettere, per esempio US."));
        country.focus();
        return;
      }
      runMeasuresLookup({
        code:code,
        flow:flow.value,
        originCountry:flow.value === "import" ? countryCode : null,
        destinationCountry:flow.value === "export" ? countryCode : null,
        operationDate:date.value,
        additionalCode:additional.value.trim().toUpperCase() || null
      }, output, submit);
    });
    section.append(heading, form, output);
    return section;
  }

  async function runMeasuresLookup(payload, output, submit){
    submit.disabled = true;
    submit.textContent = "Verifica…";
    output.replaceChildren(element("p", "customsAiMeasuresLoading", "Consulto le misure TARIC locali…"));
    try {
      var response = await fetch(api("/api/customs-ai/measures"), {
        method:"POST",
        credentials:"include",
        cache:"no-store",
        headers:{ "Content-Type":"application/json", "Accept":"application/json" },
        body:JSON.stringify(payload)
      });
      var data = await response.json().catch(function(){ return null; });
      if (!response.ok || !data || !data.success) {
        throw new Error(data && data.error || "Errore API (" + response.status + ")");
      }
      renderMeasuresResponse(data, output);
    } catch (error) {
      output.replaceChildren(element("p", "customsAiMeasuresError", error && error.message || "Misure non disponibili."));
    } finally {
      submit.disabled = false;
      submit.textContent = "Verifica misure";
    }
  }

  function renderMeasuresResponse(data, output){
    output.replaceChildren();
    if (!data.dataAvailable) {
      output.appendChild(element("p", "customsAiMeasuresEmpty", data.message || "Nessuna misura trovata per i parametri indicati."));
      return;
    }
    var summary = element("div", "customsAiMeasuresSummary");
    summary.append(
      element("strong", "", (data.measures || []).length + " misure applicabili"),
      element("span", "", decisionStatusLabel(data.decisionStatus))
    );
    output.appendChild(summary);
    if (Array.isArray(data.additionalCodes) && data.additionalCodes.length) {
      var codes = element("div", "customsAiAdditionalCodes");
      codes.appendChild(element("strong", "", "Codici addizionali comunitari"));
      data.additionalCodes.forEach(function(item){
        var row = element("p", "");
        row.append(element("code", "", item.code), document.createTextNode(" " + (item.description || "Descrizione da verificare")));
        codes.appendChild(row);
      });
      output.appendChild(codes);
    }
    if (Array.isArray(data.supplementaryUnits) && data.supplementaryUnits.length) {
      var units = element("div", "customsAiSupplementaryUnits");
      units.appendChild(element("strong", "", "Unità supplementare da dichiarare"));
      data.supplementaryUnits.forEach(function(item){
        var row = element("p", "");
        var codes = [item.declaration_code, item.code].filter(Boolean);
        row.append(
          element("code", "", codes.join(" / ")),
          document.createTextNode(" " + (item.description || "Unità TARIC") + (item.symbol ? " (" + item.symbol + ")" : "") + (item.qualifier ? " — qualificatore " + item.qualifier : ""))
        );
        units.appendChild(row);
      });
      output.appendChild(units);
    }
    var list = element("div", "customsAiMeasureList");
    (data.measures || []).forEach(function(measure){ list.appendChild(renderMeasure(measure)); });
    output.appendChild(list);
  }

  function renderMeasure(measure){
    var item = element("article", "customsAiMeasure");
    item.appendChild(element("strong", "customsAiMeasureTitle", measure.measure_type || "Misura TARIC " + (measure.measure_type_code || "")));
    if (measure.duty) item.appendChild(element("p", "customsAiMeasureAction", measure.duty));
    if (measure.legal_reference) item.appendChild(element("p", "customsAiMeasureMeta", "Regolamento/atto: " + measure.legal_reference));
    if (measure.additional_code) {
      item.appendChild(element("p", "customsAiMeasureMeta", "Codice addizionale: " + measure.additional_code + (measure.additional_code_description ? " — " + measure.additional_code_description : "")));
    }
    var conditionGroups = Array.isArray(measure.condition_groups) ? measure.condition_groups : [];
    var conditions = Array.isArray(measure.conditions) ? measure.conditions : [];
    if (conditionGroups.length || conditions.length) {
      var conditionList = element("ul", "customsAiConditionList");
      if (conditionGroups.length) {
        conditionGroups.forEach(function(group){
          var options = Array.isArray(group.options) ? group.options : [];
          if (options.length) {
            var optionText = options.map(conditionDocumentLabel).join(" oppure ");
            conditionList.appendChild(element("li", "", (options.length > 1 ? "Alternative: " : "Documento/condizione: ") + optionText));
          }
          (group.fallback || []).forEach(function(condition){
            conditionList.appendChild(element("li", "", conditionFallbackLabel(condition)));
          });
        });
      } else {
        conditions.forEach(function(condition){ conditionList.appendChild(element("li", "", conditionDocumentLabel(condition))); });
      }
      item.appendChild(conditionList);
    }
    var footnotes = Array.isArray(measure.footnotes) ? measure.footnotes : [];
    if (footnotes.length) {
      item.appendChild(element("p", "customsAiMeasureMeta", "Note: " + footnotes.map(function(note){ return note.code; }).join(", ")));
    }
    return item;
  }

  function conditionDocumentLabel(condition){
    if (condition.certificate_code) {
      return condition.certificate_code + (condition.document && condition.document.description ? " — " + condition.document.description : "");
    }
    return conditionFallbackLabel(condition);
  }

  function conditionFallbackLabel(condition){
    var label = "Condizione " + (condition.condition_code || "da verificare");
    if (condition.action_code) label += " — azione TARIC " + condition.action_code;
    if (condition.expression) label += " — " + condition.expression;
    return label;
  }

  function decisionStatusLabel(status){
    if (status === "prohibited_or_exception_required") return "Possibile divieto o eccezione: verifica obbligatoria";
    if (status === "conditions_to_verify") return "Sono presenti condizioni/documenti da verificare";
    return "Misure disponibili: verifica il dettaglio prima dell'operazione";
  }

  function renderNoResult(data){
    var card = element("article", "customsAiAnswer customsAiNoResult");
    card.appendChild(element("div", "customsAiAnswerEyebrow", "Ricerca completata"));
    card.appendChild(element("h3", "", "Non ho ancora un candidato abbastanza affidabile"));
    card.appendChild(element(
      "p",
      "",
      data.message || "Aggiungi il tipo di prodotto, la funzione o la composizione principale."
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
