# Queue Analyzer

Zeigt Mythic+ Season Best/Median DPS % und Runs (WarcraftLogs) für Bewerber
in deiner Gruppenanzeige an.

(Arbeitstitel -- Projektordner heißt intern noch `archon-helper`, das
Addon selbst heißt jetzt "Queue Analyzer".)

## Konzept

1. **WoW-Addon** (`addon/QueueAnalyzer`) -- liest alle aktuellen Bewerber
   deiner Premade-Group-Finder-Anzeige aus (`C_LFGList.GetApplicants()`) und
   zeigt sie als kopierbare Liste (`Name-Realm`, eine Zeile pro Person) in
   einem Fenster an. Tastenkombination (in den WoW-Keybindings unter
   "Queue Analyzer" zuweisbar) oder `/qa`. **Fertig, installiert, noch
   nicht live im Spiel getestet.**
2. **Next.js-Webanwendung** (`webapp/`) -- Namensliste einfügen, App fragt
   WCL für jeden Namen ab, zeigt Best/Median DPS % Avg + Runs. Rein
   persönliches Tool ohne Login (Zugriffsschutz übernimmst du selbst, z. B.
   Authentik vor dem Proxmox-Container). **Live getestet, funktioniert.**

Ein WCL-OAuth-Login pro Nutzer war zwischenzeitlich geplant und gebaut,
dann wieder entfernt: live verifiziert, dass WCLs Rate-Limit strikt am
API-Client hängt, nicht am eingeloggten Nutzer -- ein Login hätte also kein
separates Kontingent gebracht. Details siehe `webapp/README.md`.

Der noch ältere Ansatz (Go-Kommandozeilen-Tool, lokale Massenabfrage aller
EU-Charaktere, Tray-Hintergrunddienst) wurde ebenfalls verworfen -- Details
nur noch in der Chat-Historie, nicht mehr im Code.

## Funktionsweise des Addons

WoW-Addons haben keinen Netzwerkzugriff (Blizzards Sandbox verbietet das
komplett) -- das Addon fragt also nichts selbst bei WCL ab. Es sammelt nur
die Namen, die du sonst mühsam einzeln nachschlagen müsstest, und macht sie
in einem Rutsch kopierbar:

1. Du bist Gruppenleiter einer Anzeige mit Bewerbern.
2. Tastenkombination drücken (oder `/qa`) -- Fenster öffnet sich, Textfeld
   ist automatisch markiert.
3. Strg+C -- alle Bewerbernamen sind in der Zwischenablage.
4. In der Webanwendung (`webapp/`) einfügen, abfragen.

## Addon installieren

Ordner `addon/QueueAnalyzer` nach
`D:\Blizzard\World of Warcraft\_retail_\Interface\AddOns\QueueAnalyzer`
kopieren (oder symlinken), danach `/reload` oder neu einloggen.

## Webanwendung

Siehe `webapp/README.md` für Setup (WCL-API-Client anlegen, Zone-ID
ermitteln, lokal oder per Docker starten).

## Offene Punkte

- **Addon live im Spiel noch nicht getestet** (kein WoW-Client hier
  verfügbar). Die Blizzard-API (`C_LFGList.GetApplicants`/
  `GetApplicantInfo`/`GetApplicantMemberInfo`) ist gegen Blizzards eigenen
  UI-Quellcode verifiziert, aber bitte einmal in einer echten
  Gruppenanzeige mit Bewerbern ausprobieren und Rückmeldung geben.
