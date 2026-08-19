# Contratto di importazione DOGANA AI

Per il normale aggiornamento ufficiale non serve preparare un file manuale:

```text
npm run update-taric
```

Questo comando legge gli Excel TARIC pubblicati da DG TAXUD su CIRCABC e usa
l'indice AIDA soltanto per completare le righe italiane più recenti non ancora
incluse nello snapshot mensile IT.

Lo script accetta JSON normalizzato oppure CSV UTF-8.

Per JSON, l'oggetto può contenere le tabelle elencate nello schema MVP. La tabella
minima è `tariff_codes`; le altre vengono inizializzate come array vuoti. Ogni codice
deve avere `code` e `description`. Lo script normalizza i codici, costruisce
`tariff_hierarchy`, aggiunge i metadati temporali, valida e scrive in modo
transazionale.

Per CSV sono riconosciute queste colonne:

`code,description,keywords,synonyms,product_types,materials,functions,required_attributes,source_id,valid_from,valid_to`

I campi multipli usano `|` oppure `;` come separatore.

Esempio di sola validazione:

```text
npm run import-customs-data -- --source data/customs/imports/dataset.json --source-name "TARIC UE" --source-version "VERSIONE" --valid-from 2026-01-01 --dry-run
```

Non usare `--official` finché provenienza, versione e completezza del file non sono
state verificate. Quando esiste già un dataset, l'importer lo sposta prima in
`processed/backups/` e ripristina il precedente se la sostituzione fallisce.
