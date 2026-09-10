# Queue Analyzer

Zeigt Mythic+ Season Best/Median DPS % und Runs (WarcraftLogs) für Bewerber
in deiner Gruppenanzeige an.

(Arbeitstitel -- Projektordner heißt intern noch `archon-helper`, das
Addon selbst heißt jetzt "Queue Analyzer".)

## Konzept (Stand: Neustart)

1. **WoW-Addon** (`addon/QueueAnalyzer`) -- liest alle aktuellen Bewerber
   deiner Premade-Group-Finder-Anzeige aus (`C_LFGList.GetApplicants()`) und
   zeigt sie als kopierbare Liste (`Name-Realm`, eine Zeile pro Person) in
   einem Fenster an. Tastenkombination (in den WoW-Keybindings unter
   "Queue Analyzer" zuweisbar) oder `/qa`. **Fertig, installiert, bereit
   zum Testen im Spiel.**
2. **Next.js/Node.js-Webanwendung** (`webapp/`) -- mit WarcraftLogs-OAuth-
   Login (statt fest hinterlegtem Client-ID/Secret-Paar). Du fügst die
   kopierte Namensliste dort ein, die App fragt WCL für jeden Namen ab und
   zeigt Best/Median DPS % Avg + Runs an. Zum Selbst-Hosten gedacht (z. B.
   Proxmox-LXC-Container über GitHub). **Code steht, aber der OAuth-Login
   ist noch nicht live getestet** -- siehe `webapp/README.md` für Setup und
   die offenen Punkte dazu.

Der alte Ansatz (Go-Kommandozeilen-Tool, lokale Massenabfrage aller
EU-Charaktere, Tray-Hintergrunddienst) wurde verworfen -- Details dazu nur
noch in der Chat-Historie, nicht mehr im Code.

## Funktionsweise des Addons

WoW-Addons haben keinen Netzwerkzugriff (Blizzards Sandbox verbietet das
komplett) -- das Addon fragt also nichts selbst bei WCL ab. Es sammelt nur
die Namen, die du sonst mühsam einzeln nachschlagen müsstest, und macht sie
in einem Rutsch kopierbar:

1. Du bist Gruppenleiter einer Anzeige mit Bewerbern.
2. Tastenkombination drücken (oder `/qa`) -- Fenster öffnet sich, Textfeld
   ist automatisch markiert.
3. Strg+C -- alle Bewerbernamen sind in der Zwischenablage.
4. (Bis Schritt 2 des Konzepts steht: manuell bei WCL nachschlagen, oder
   auf die Webanwendung warten.)

## Addon installieren

Ordner `addon/QueueAnalyzer` nach
`D:\Blizzard\World of Warcraft\_retail_\Interface\AddOns\QueueAnalyzer`
kopieren (oder symlinken), danach `/reload` oder neu einloggen.

## Offene Punkte

- **Live im Spiel noch nicht getestet** (kein WoW-Client hier verfügbar).
  Die Blizzard-API (`C_LFGList.GetApplicants`/`GetApplicantInfo`/
  `GetApplicantMemberInfo`) ist gegen Blizzards eigenen UI-Quellcode
  verifiziert, aber bitte einmal in einer echten Gruppenanzeige mit
  Bewerbern ausprobieren und Rückmeldung geben.
- **WCL-OAuth-Verhalten für die geplante Webanwendung noch nicht
  abschließend verifiziert**: erste Recherche deutet darauf hin, dass das
  Punkte-Rate-Limit pro registrierter App (Client), nicht pro
  eingeloggtem Nutzer gilt -- d. h. OAuth-Login würde vermutlich primär
  die Zugangsdaten-Verwaltung vereinfachen, aber nicht automatisch mehr
  API-Kapazität bringen. Muss vor dem Bau von Schritt 2 genauer geklärt
  werden.
