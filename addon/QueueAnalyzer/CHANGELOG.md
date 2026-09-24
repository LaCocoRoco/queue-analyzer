**v3.1.0 (2026-09-24)**

- Export field now clears itself right after Ctrl+C, so an empty field means "already copied" and a stale export can't be mistaken for a fresh one.
- Import field now clears itself after a successful Import.
- Web app: imported applicants now stay in the table across multiple imports (instead of being replaced each time), as long as the dungeon and target key level haven't changed -- lets you cross-reference logs against everyone you looked at this session.
- Web app: skips re-querying WarcraftLogs/RaiderIO for applicants already looked up this session -- faster imports, fewer API requests.

**v3.0.0 (2026-09-23)**

- Filter: replaced the two independent LOG/SCORE sliders with a single LOG↔SCORE balance slider (center = 50/50).
- Score is now normalized against a dynamic ceiling derived from your held Mythic+ keystone level, instead of a fixed 4000 — more accurate when recruiting for a specific key level.
- Removed Raid support (Mythic+ only again).

**v2.0.4 (2026-09-18)**

- Fixed the in-game addon-list icon (was showing a generic "?" placeholder).

**v2.0.1 (2026-09-15)**

- Export/Import fields now start empty every time the Analyzer window opens.
- Fixed the onboarding screen's suggested WarcraftLogs API client name/redirect URL.

**v2.0.0 (2026-09-15)**

- Added Raid support alongside Mythic+.

**v1.0.0 (2026-09-14)**

- Added RaiderIO spec Tier grades (S/A/B/C), shown as a Tier column (web app) and colored letter (in-game).
- Export now includes the applicant's live spec ID and role directly from the addon.
- Removed the old Table/Name display toggle; only the table view remains.
