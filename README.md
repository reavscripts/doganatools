# DoganaTools

Utility web avanzata per operazioni doganali e monitoraggio container in tempo reale.

## Funzionalità

- Tracking container multi-terminal
- Controllo automatico:
  - SCT
  - CONATECO
  - TFG
- Monitoraggio navi in chiusura
- Ricerca rapida navi
- Generazione PDF automatica documenti JMT
- Cache condivisa intelligente
- Notifiche desktop container entrati
- Export PDF liste container
- Copia rapida container / colonne
- Ottimizzata per desktop e mobile
- Compatibile LAN / Cloudflare Tunnel / Vercel

## Architettura

Frontend:
- HTML/CSS/JS statico
- Deployabile su Vercel

Backend:
- Node.js + Express
- Puppeteer
- Cache locale condivisa
- Sessioni persistenti SCT/JMT

## Deploy consigliato

```text
Vercel -> Frontend
Cloudflare Tunnel -> Backend locale
