# Queue Analyzer

See who's actually applying to your Mythic+ group — WarcraftLogs percentile, RaiderIO/Blizzard score, and a spec strength grade, right in the Group Finder.

**Web app:** https://lacocoroco.github.io/queue-analyzer/
**Addon:** https://www.curseforge.com/wow/addons/queueanalyzer

## How it works

1. **Export** — in WoW, open the Analyzer window (`/qa`) and copy the applicant list.
2. **Analyze** — paste it into the web app and click Import. It queries WarcraftLogs and RaiderIO for every applicant.
3. **Import** — copy the result back into the addon. Rank, Log %, and Tier now show right in the applicant list.

## What you get

- **Log** — WarcraftLogs season or current-dungeon performance percentile
- **Score** — Blizzard's in-game rating, or a live RaiderIO lookup
- **Rank** — a colored star for the top 4 applicants, blending Log and Score
- **Tier** — S/A/B/C spec strength grade, from RaiderIO's population data

No login, no server. Each browser stores its own WarcraftLogs API credentials locally; everything runs client-side.
