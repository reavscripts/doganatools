# DoganaTools

Utility web per operazioni doganali, monitoraggio container e assistenza alla
classificazione HS/CN/TARIC.

## Funzionalità

- tracking container SCT, CONATECO e TFG;
- monitoraggio navi in chiusura e ricerca booking;
- generazione ed esportazione documenti operativi;
- stato condiviso, checklist, notifiche e post-it;
- **DOGANA AI — V0.4.1**: ricerca TARIC istantanea da una sola barra,
  classificazione gerarchica, ipotesi esplicite, alternative, fonti e storico.

## Avvio locale

Requisiti: Node.js 20 o successivo.

```text
npm install
npm start
```

Aprire `http://localhost:3000`. L'accesso continua a usare il sistema utenti già
presente in `data/auth/`.

Per eseguire i test:

```text
npm test
```

Per provare soltanto DOGANA AI senza login, su un server accessibile esclusivamente
dal PC locale:

```text
npm run preview:customs-ai
```

Aprire `http://127.0.0.1:4173/preview`. Questa modalità non modifica né disattiva
l'autenticazione del server normale.

## DOGANA AI

Endpoint protetti dalla stessa autenticazione delle API esistenti:

```text
GET  /api/customs-ai/status
POST /api/customs-ai/analyze
POST /api/customs-ai/classify
POST /api/customs-ai/measures
```

Il backend è separato in:

- `routes/customsAI.js` per il contratto HTTP;
- `services/customsAI/` per analisi, ricerca, gerarchia, scoring, validazione,
  fonti, storico, misure e provider AI;
- `repositories/tariffRepository.js` per l'accesso ai dati;
- `data/customs/` per import, dati processati, documentazione fonti e storico;
- `public/customs-ai/` per interfaccia e stile condivisi dai frontend.

Il motore usa una ricerca ibrida e gerarchica: interpreta il bene venduto,
separa destinatario, uso, materiale, macchine, contenitori e accessori, sceglie
soltanto tra rami HS/CN realmente presenti nel database e infine valuta le
sottovoci figlie. Il fallback senza LLM resta disponibile tramite ricerca
lessicale, sinonimi, tolleranza agli errori e regole deterministiche. Il file incluso in
`data/customs/processed/` contiene lo snapshot ufficiale TARIC UE 2026-08:
16.708 codici dichiarabili e 25.830 righe di nomenclatura. Le 92 descrizioni
italiane pubblicate dopo l'ultimo Excel IT mensile sono integrate dall'indice
AIDA aggiornato al 19/08/2026; non restano righe con fallback inglese.

La ricerca non si interrompe per mostrare questionari: quando i dati consentono
di riconoscere soltanto una famiglia HS/CN, il risultato si ferma a quel livello
e indica i dettagli necessari, invece di forzare una TARIC a 10 cifre. Quando i
dati sono sufficienti restituisce subito la sottovoce completa. Le alternative
restano disponibili in un pannello secondario. Le percentuali servono a
confrontare i candidati e non esprimono certezza giuridica; materiale e altri
dettagli modificano l'ordine senza applicare automaticamente filtri esclusivi.

### Interpretazione semantica locale o OpenAI

In assenza di configurazione esplicita DOGANA AI usa Ollama in locale, avviandolo
se necessario, con il modello `qwen3.5:9b`. Il modello interpreta il significato
commerciale ma non è la fonte dei codici: ogni scelta viene limitata e verificata
contro la nomenclatura ufficiale installata.

Per scegliere un altro modello Ollama:

```powershell
$env:CUSTOMS_AI_PROVIDER="ollama"
$env:CUSTOMS_AI_OLLAMA_MODEL="qwen3.5:9b"
npm start
```

In alternativa si può configurare OpenAI; le chiavi restano esclusivamente nelle
variabili ambiente:

```powershell
$env:CUSTOMS_AI_PROVIDER="openai"
$env:CUSTOMS_AI_MODEL="<modello-configurato-per-il-deployment>"
$env:OPENAI_API_KEY="<chiave>"
npm start
```

Per disattivare esplicitamente ogni modello usare
`CUSTOMS_AI_PROVIDER=disabled`. Il fallback lessicale rimane operativo. Nessun
provider può creare una TARIC o diventare la fonte normativa.

Per le richieste brevi Ollama usa valori ottimizzati (`num_predict=200`,
`num_ctx=2048`, `keep_alive=4h`) e una cache temporale per interpretazione e
spareggi HS. Le variabili `CUSTOMS_AI_NUM_PREDICT`, `CUSTOMS_AI_NUM_CTX`,
`CUSTOMS_AI_KEEP_ALIVE`, `CUSTOMS_AI_CACHE_TTL_MS` e
`CUSTOMS_AI_CACHE_MAX_ENTRIES` consentono di modificarli. La selezione TARIC
finale resta locale; una seconda chiamata AI viene eseguita soltanto quando i
primi due rami HS sono realmente vicini.

### Misure TARIC per paese

`POST /api/customs-ai/measures` accetta un codice CN a 8 cifre o TARIC a 10,
il flusso, la data e il paese interessato. Per l'esportazione è obbligatorio
`destinationCountry`; per l'importazione è obbligatorio `originCountry`.

```json
{
  "code": "39051200",
  "flow": "export",
  "destinationCountry": "US",
  "operationDate": "2026-08-24",
  "additionalCode": null
}
```

La risposta distingue misure, restrizioni, condizioni alternative, codici
documento/certificato (per esempio `Y923`), note, riferimenti normativi, opzioni
di codice addizionale comunitario (per esempio `4099`) e unità supplementari
quando previste. Le misure impostate su livelli superiori della nomenclatura
sono ereditate dal codice TARIC richiesto. I gruppi geografici e le relative
esclusioni sono risolti per la data dell'operazione. Il campo `decisionStatus`
indica se le condizioni devono essere verificate; non sostituisce la valutazione
doganale.

### Import dati doganali

Per aggiornare automaticamente la nomenclatura dalla fonte ufficiale della
Commissione europea e integrare le righe italiane più recenti da AIDA:

```text
npm run update-taric
```

Lo script individua da solo l'ultimo mese completo, scarica gli Excel ufficiali,
confronta i codici dichiarabili e importa anche Duties Import/Export, condizioni
separate o incorporate nell'espressione della misura, esclusioni, note, gruppi
geografici, codici documento, codici addizionali e unità supplementari.
Recupera da AIDA le eventuali descrizioni IT non ancora presenti nell'Excel
mensile, valida conteggi e duplicati e sostituisce il dataset in modo
transazionale. `--dry-run` esegue l'intero controllo senza scrivere;
`--no-aida` mantiene il fallback inglese per le righe IT mancanti e
`--no-measures` aggiorna soltanto la nomenclatura.

L'import è separato dall'avvio del server e supporta JSON normalizzato o CSV:

```text
npm run import-customs-data -- --source data/customs/imports/dataset.json --source-name "TARIC UE" --source-version "VERSIONE" --valid-from 2026-01-01 --dry-run
```

Rimuovere `--dry-run` soltanto dopo la validazione. L'importer normalizza i codici,
costruisce la gerarchia, registra la versione, crea un backup del dataset corrente
e sostituisce il file in modo transazionale. L'opzione `--official` richiede una
verifica umana preventiva di provenienza e completezza.

Il contratto sorgente è descritto in `data/customs/imports/README.md`.

## Copertura e limiti

La nomenclatura completa è installata. L'importatore V0.4.1 aggiunge le misure
comunitarie presenti nelle estrazioni TARIC; il dataset va rigenerato con
`npm run update-taric` dopo l'aggiornamento del codice. Restano fonti e moduli
distinti da integrare per un trattamento doganale completo:

- misure nazionali (IVA, accise e altri tributi non contenuti in TARIC), Note
  Esplicative CN complete, CLASS e ITV/BTI;
- valutazione documentale della singola operazione, contingenti con saldo in
  tempo reale e controlli delle autorità competenti.

La struttura JSON dell'MVP è dietro un repository dedicato, quindi potrà essere
sostituita da PostgreSQL e ricerca vettoriale senza spostare query nel frontend o
nelle route.

## Architettura generale

Frontend: HTML/CSS/JavaScript statico, adatto al deploy pubblico esistente.

Backend: Node.js, Express, Puppeteer, cache locale condivisa e sessioni persistenti
SCT/JMT.

Deploy consigliato:

```text
Vercel -> Frontend
Cloudflare Tunnel -> Backend locale
```
