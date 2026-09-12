# Queue Analyzer

Shows Mythic+ season Best/Median DPS % and Runs (WarcraftLogs) for
applicants in your Group Finder listing.

**Web app:** https://lacocoroco.github.io/queue-analyzer/

## Concept

1. **WoW addon** (`addon/QueueAnalyzer`) -- reads all current applicants of
   your Premade Group Finder listing and exports them, together with
   Blizzard's own in-game Mythic+ rating, as a copyable string. The same
   window takes the ranked result copied back from the webapp and shows it
   directly in the applicant list. Keybinding, `/qa`, or a button in the
   applicant window.
2. **Web app** (`webapp/`) -- one button: "Read from Clipboard" reads the
   applicant list, queries WCL (and optionally raider.io) for each name,
   and writes the result straight back to the clipboard, ready to paste
   into the addon. Fully static (no server); runs entirely in the browser.
   No login -- each browser enters its own WCL Client ID/Secret once
   (onboarding screen, stored in the browser only).

## Web app

See `webapp/README.md` for setup and deployment (GitHub Pages).
