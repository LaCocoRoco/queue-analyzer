# Queue Analyzer

Shows Mythic+ season Best/Median DPS % and Runs (WarcraftLogs) for
applicants in your Group Finder listing.

## Concept

1. **WoW addon** (`addon/QueueAnalyzer`) -- reads all current applicants of
   your Premade Group Finder listing and exports them as a copyable
   `Name-Realm:Name-Realm:...` string. A second import window takes the
   `Name-Realm:Best:...` string copied back from the webapp and shows the
   Best value (colored) directly in the applicant tooltip. Keybinding,
   `/qa` (export) / `/qai` (import), buttons in the applicant window.
2. **Web app** (`webapp/`) -- one button: "Read from Clipboard" reads the
   applicant list, queries WCL for each name, and writes the result
   straight back to the clipboard, ready to paste into the addon's import
   window. Fully static (no server); runs entirely in the browser. No
   login -- each browser enters its own WCL Client ID/Secret once
   (onboarding screen, stored in the browser only).

## Addon install

Copy `addon/QueueAnalyzer` to
`World of Warcraft/_retail_/Interface/AddOns/QueueAnalyzer`, then
`/reload` or relog.

## Web app

See `webapp/README.md` for setup and deployment (GitHub Pages).
