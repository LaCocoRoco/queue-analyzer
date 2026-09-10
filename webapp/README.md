# Queue Analyzer -- Web

Next.js-Anwendung: Liste von `Name-Realm` einfügen (aus dem WoW-Addon
kopiert), fragt WarcraftLogs für jeden Namen ab, zeigt Best/Median DPS %
Avg + Runs für die aktuelle Mythic+ Season.

Login läuft über WarcraftLogs-OAuth (Authorization-Code-Flow) -- die App
selbst hält einen einzigen registrierten API-Client (Umgebungsvariablen,
niemals im Browser sichtbar), aber jeder Nutzer meldet sich mit seinem
**eigenen** WCL-Account an, statt dass ein Client-ID/Secret-Paar verteilt
werden müsste.

**Nicht verifiziert:** Ich konnte den OAuth-Login-Flow in dieser Umgebung
nicht end-to-end testen (kein Browser für den echten WCL-Consent-Screen
verfügbar). Alles unten basiert auf WCLs dokumentierten OAuth-Endpunkten
und der bereits live verifizierten GraphQL-Query-Struktur -- aber der
erste echte Login-Versuch ist der eigentliche Test. Wenn dabei ein Fehler
auftritt, am wahrscheinlichsten:

- **`WCL_API_ENDPOINT`**: Standardmäßig `/api/v2/user` (für
  User-OAuth-Tokens). Falls das einen Auth-Fehler gibt, in `.env` auf
  `https://www.warcraftlogs.com/api/v2/client` umstellen und erneut
  versuchen.
- **Redirect-URI-Mismatch**: Muss in `.env` (`WCL_REDIRECT_URI`) exakt so
  eingetragen sein wie beim Anlegen des API-Clients bei WCL (Protokoll,
  Host, Port, Pfad -- alles exakt gleich).

## Setup

### 1. WarcraftLogs API-Client anlegen

1. https://www.warcraftlogs.com/api/clients/ -- "Create Client".
2. **Redirect URL**: `http://<deine-proxmox-ip>:3000/api/auth/callback`
   (oder deine Domain, falls vorhanden -- muss exakt mit
   `WCL_REDIRECT_URI` übereinstimmen).
3. Client ID + Secret notieren.

### 2. Zone-ID für die aktuelle Mythic+ Season finden

Am einfachsten mit einem kurzen manuellen GraphQL-Request (z.B. via
curl oder Postman) gegen `https://www.warcraftlogs.com/api/v2/client`
(Client-Credentials-Token vom selben Client), Query:

```graphql
{ worldData { zones { id name partitions { id name } } } }
```

Zone mit Namen wie "Mythic+ Season X" suchen, `id` und die passende
`partition.id` notieren.

### 3. Environment konfigurieren

```
cp .env.example .env
```

Alle Werte ausfüllen (Client ID/Secret aus Schritt 1, Zone-ID/Partition
aus Schritt 2, Region z.B. `EU`).

### 4. Auf dem Proxmox-LXC-Container laufen lassen

**Direkt mit Node.js** (falls im Container installiert):

```
git clone <dieses-repo> queue-analyzer
cd queue-analyzer/webapp
cp .env.example .env   # ausfuellen, siehe oben
npm install
npm run build
npm start               # laeuft auf Port 3000
```

Für Dauerbetrieb z.B. mit `pm2` oder einem systemd-Service starten, statt
das Terminal offen zu lassen.

**Alternativ mit Docker** (falls im Container Docker läuft):

```
docker build -t queue-analyzer-web .
docker run -d --name queue-analyzer -p 3000:3000 --env-file .env queue-analyzer-web
```

### 5. Testen

1. `http://<ip>:3000` öffnen -- "Mit WarcraftLogs einloggen" klicken.
2. Nach dem Login: ein paar Testzeilen wie `Jondrejss-Aszune` einfügen,
   "Abfragen" klicken.
3. Falls ein Fehler kommt: siehe "Nicht verifiziert" oben, dann kurz
   zurückmelden -- dann passen wir den Code gezielt an.

## Bekannte Vereinfachungen

- Session liegt in einem httpOnly-Cookie (kein DB, kein Redis) -- reicht
  für ein Tool mit wenigen Nutzern, ist aber kein produktionsreifes
  Multi-Tenant-Setup.
- Rate-Limit-Realität: Das WCL-Punktelimit gilt vermutlich pro API-Client
  (dieser App), nicht pro eingeloggtem Nutzer -- alle Nutzer teilen sich
  effektiv denselben 3.600-Punkte/Stunde-Topf. OAuth-Login vereinfacht vor
  allem die Zugangsdaten-Verwaltung, erhöht aber wahrscheinlich nicht die
  Gesamtkapazität.
