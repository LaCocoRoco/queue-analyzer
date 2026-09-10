# Queue Analyzer -- Web

Next.js-Anwendung: Liste von `Name-Realm` einfügen (aus dem WoW-Addon
kopiert), fragt WarcraftLogs für jeden Namen ab, zeigt Best/Median DPS %
Avg + Runs für die aktuelle Mythic+ Season.

Rein persönliches Tool, kein Login: Ein einzelner serverseitiger
WCL-API-Client (Client-Credentials-Flow) reicht -- Zugriffsschutz von außen
übernimmst du selbst (z. B. über Authentik vor dem Container). Live
getestet und funktionsfähig.

Ursprünglich war ein WCL-OAuth-Login pro Nutzer geplant, damit jeder sein
eigenes Punkte-Kontingent nutzt. Live verifiziert (zwei unterschiedliche
WCL-Accounts, derselbe registrierte API-Client): Das Rate-Limit hängt
strikt am `client_id`, nicht am eingeloggten Nutzer -- ein Login hätte also
kein separates Kontingent gebracht, nur unnötige Komplexität. Deshalb
entfernt.

## Setup

### 1. WarcraftLogs API-Client anlegen

1. https://www.warcraftlogs.com/api/clients/ -- "Create Client".
2. Redirect-URL: beliebig (z. B. `http://localhost`), wird für
   Client-Credentials nicht genutzt.
3. Client ID + Secret notieren.

### 2. Zone-ID für die aktuelle Mythic+ Season finden

Kurzer manueller GraphQL-Request gegen
`https://www.warcraftlogs.com/api/v2/client` (Token via Client-Credentials
vom selben Client), Query:

```graphql
{ worldData { zones { id name partitions { id name } } } }
```

Zone mit Namen wie "Mythic+ Season X" suchen, `id` und passende
`partition.id` notieren.

### 3. Environment konfigurieren

```
cp .env.example .env
```

Alle Werte ausfüllen (Client ID/Secret aus Schritt 1, Zone-ID/Partition aus
Schritt 2, Region z. B. `EU`).

### 4. Lokal testen

```
npm install
npm run build
npm start        # http://localhost:3000
```

### 5. Auf dem Server laufen lassen

**Direkt mit Node.js:**

```
git clone <dieses-repo> queue-analyzer
cd queue-analyzer/webapp
cp .env.example .env   # ausfuellen
npm install
npm run build
npm start               # Port 3000
```

Für Dauerbetrieb mit `pm2` oder einem systemd-Service statt offenem
Terminal.

**Mit Docker:**

```
docker build -t queue-analyzer-web .
docker run -d --name queue-analyzer -p 3000:3000 --env-file .env queue-analyzer-web
```

Zugriffsschutz (Authentik o. ä.) läuft davor, nicht Teil dieser App.
