# Queue Analyzer -- Web

Static Next.js app: "Read from Clipboard" reads the applicant list (copied
from the WoW addon), queries WarcraftLogs for each name, and writes the
result back to the clipboard as `Name-Realm:Best:...`, ready to paste into
the addon's import window. No server -- WCL's OAuth and GraphQL endpoints
both allow direct browser requests (CORS), so the app runs entirely
client-side and deploys as a static export.

No login: each browser enters its own WCL Client ID/Secret once
(onboarding screen), stored only in that browser.

## Setup

1. **Create a WCL API client**: https://www.warcraftlogs.com/api/clients/
   -- "Create Client". Application Name `analyzer`, Redirect URL
   `http://analyzer.com`. Enter Client ID/Secret in the app itself when
   prompted.
2. **Find the current Mythic+ season's zone ID**: query
   `https://www.warcraftlogs.com/api/v2/client` (token via client
   credentials from the same client):
   ```graphql
   { worldData { zones { id name partitions { id name } } } }
   ```
   Find the zone named "Mythic+ Season X", note its `id` and matching
   `partition.id`.
3. **Configure and run locally**:
   ```
   cp .env.example .env   # fill in zone ID/partition from step 2, region e.g. EU
   npm install
   npm run dev             # http://localhost:3000
   ```
4. **Test the actual static export** (what gets deployed):
   ```
   npm run build            # produces webapp/out/
   npm run serve             # static preview server over out/
   ```

## Deploy: GitHub Pages (free, no server)

`.github/workflows/deploy-pages.yml` builds and deploys `webapp/` on every
push that touches it.

1. Repo settings -> Pages -> Source: "GitHub Actions".
2. Repo settings -> Secrets and variables -> Actions -> Variables: add
   `WCL_REGION`, `WCL_ZONE_ID`, `WCL_PARTITION` (public season config, not
   secrets).
3. Push to `master` (or run the workflow manually) -- served at
   `https://<username>.github.io/queue-analyzer/`.

Note: GitHub Pages for a private repo needs GitHub Pro or higher on a
personal account; on the free plan the repo must be public. Nothing
sensitive lives in the repo (Client ID/Secret stay in each user's own
browser), so a public repo is fine.
