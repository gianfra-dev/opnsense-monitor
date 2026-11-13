# OPNsense Monitor

Dashboard HTML (tema terminale neon, grafici 3D a colonne o linee) per monitorare i consumi di dati del router OPNsense: totali **orari, giornalieri e mensili**, divisi per **WAN** e **LAN** (ricevuti / inviati). Nessuna dipendenza esterna, nessun CDN.

## Avvio con Docker

```bash
docker compose up -d --build
```

oppure:

```bash
docker build -t opnsense-monitor .
docker run -d --name opnsense-monitor -p 3000:3000 -v monitor-data:/data --restart unless-stopped opnsense-monitor
```

Apri `http://<host>:3000`: al primo avvio vieni portato alla pagina di installazione (`/setup.html`) dove inserisci IP del router, API key/secret, scegli le interfacce e il ruolo (WAN/LAN).

## API key su OPNsense

*Sistema → Accesso → Utenti* → modifica un utente → "Chiavi API" → `+`. Scarica il file con key e secret.
L'utente deve avere il privilegio **Diagnostics: Traffic** (usa l'endpoint `/api/diagnostics/traffic/interface`).
Se il certificato HTTPS del router è autofirmato lascia disattivata la verifica TLS.

## Come funziona

- Ogni 30 s (configurabile) legge i contatori byte delle interfacce e somma la differenza nel bucket orario corrente.
- Giorni e mesi sono aggregati dai dati orari. Se i contatori si azzerano (riavvio del router) viene gestito automaticamente.
- I dati sono in `/data` (volume): `config.json` (contiene il secret, permessi 600) e `stats.json`.
- Fuso orario: variabile `TZ` (default `Europe/Rome`).
- Esportazione dei dati orari: `/api/export.csv`.
- Uptime e load del router: letti da `/api/diagnostics/system/systemTime`. Se l'utente API non ha accesso a quell'endpoint la scheda mostra "n/d" e il resto continua a funzionare.

> La pagina non ha autenticazione: esponila solo nella tua LAN.
