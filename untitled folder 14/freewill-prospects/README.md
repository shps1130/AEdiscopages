# FreeWill Prospect Pages

Discovery call transcript → reviewed, on-brand, single-file prospect page at `/p/your-slug` — in minutes, with the AE approving everything before it ships.

## Architecture (the TSR pattern, plus publishing)

```
index.html          AE tool: form + transcript → brief review → preview → revise → publish
admin.html          Marketing: knowledge base upload (Haiku writes retrieval summaries)
api/generate.js     Haiku extracts brief → assets matched from Supabase → Sonnet writes page
api/pages.js        List / edit / AI-revise / publish / archive
api/assets.js       Knowledge base CRUD
api/p/[slug].js     Serves published pages, logs prospect views (noindex)
schema.sql          Supabase: pages, assets, page_views + seed assets
vercel.json         /p/:slug rewrite + noindex headers
```

No build step. No framework. Published pages live in Supabase, not in the repo —
publish and edits are instant, no redeploys.

## Deploy (≈20 minutes)

1. **Supabase**: new project → SQL editor → run `schema.sql`. Grab the project URL and the **service_role** key (Settings → API). RLS is on with no policies, so the anon key can touch nothing — all access goes through the serverless functions.
2. **Repo**: push this folder to GitHub. Add a `package.json` dependency: run `npm init -y && npm i @supabase/supabase-js` locally, commit `package.json` + lockfile.
3. **Vercel**: import the repo. Set env vars:
   - `ANTHROPIC_API_KEY` — from the Claude Console (company account, not personal)
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `TEAM_ACCESS_CODE` — the shared code AEs/marketing enter
4. Point `freewillprospects.com` (or whatever domain gets approved) at the Vercel project.
5. In `admin.html`, replace the seed assets' `REPLACE-ME` URLs with real materials.

## Vercel settings that matter

- **Function max duration**: page generation takes 60–120s. On Vercel Hobby, functions cap at 10s by default — set `maxDuration` or upgrade to Pro (Pro allows up to 300s). Add to `vercel.json` if on Pro:
  ```json
  "functions": { "api/generate.js": { "maxDuration": 180 }, "api/pages.js": { "maxDuration": 180 } }
  ```
  This is the most likely first deploy failure. If generation times out, this is why.

## Security model (v1) and the upgrade path

- Shared `TEAM_ACCESS_CODE` checked server-side on every internal call. Fine for a pilot; rotate it when people leave.
- Prospect pages are public-but-unlisted: noindex headers + non-enumerable slugs. Don't put anything on a page you wouldn't want the prospect's whole org to read (that's the point — they forward it).
- **Before company-wide rollout**: swap the access code for Google SSO restricted to the freewill.com domain (Supabase Auth or Vercel's auth middleware both work), and add per-AE identity so "created_by" is trustworthy.
- Transcripts are sent to the API and the extracted brief is stored; the raw transcript is NOT stored. Check with legal/ops whether Gong transcript reuse needs disclosure language.

## Cost expectations

- Extraction (Haiku): ~2¢/page. Generation (Sonnet, template cached): ~50–80¢/page. Revisions: ~40–70¢ each.
- The template spec in `generate.js` uses prompt caching (`cache_control`), so the static instructions cost full price once per 5-minute window, then 10%.

## Roadmap slots already accounted for

- **v1.5**: brief-editing before generation (AE corrects the brief, then generates)
- **v2**: retrieval upgrade — embeddings over asset summaries instead of tag matching; per-view analytics dashboard (opens over time, per page)
- **v3**: Gong API — pick a call from a dropdown instead of pasting; Google SSO
