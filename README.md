# Adversarial Review

A [Reddit Devvit](https://developers.reddit.com/docs) Web app. It adds a **"Request Adversarial LLM Review"** post-menu action: a Supabase Edge Function produces a rigorous, LLM-generated physics critique of the post (or of the manuscript it links), and the app posts that critique as a distinguished comment.

- **Devvit app:** `adversarial-review` · **Baseline version:** `1.0.0` (see the note under Versioning)
- **Legal:** [Terms](https://allhailseizure.github.io/adversarial-review/terms/) · [Privacy](https://allhailseizure.github.io/adversarial-review/privacy/)
- Built from [`AllHailSeizure/devvit-app-template`](https://github.com/AllHailSeizure/devvit-app-template). The app was moved out of [`AllHailSeizure/Reddit-Devvit`](https://github.com/AllHailSeizure/Reddit-Devvit) at source commit `649cd2a9e8fece8b3253d373f34ff911e42f931e`. The `adversarial-review/` subfolder history is preserved. The Supabase pieces were copied from `moderator-toolbox/supabase/` at the same commit.

## How it works

```
User: post menu → "Request Adversarial LLM Review"
  │  gates: enabled setting · one review per post (7-day lock) · not removed/spam
  │         · optional required flair · non-mods: one request per UTC day (bypassed on r/llmphysics_dev)
  │  0 links  → form "adversarial-no-link" (optional manuscript URL)
  │  2+ links → form "adversarial-multi-link" (pick one / Other / None)
  ▼
POST {supabaseUrl}/rest/v1/review_jobs        (409 = already queued; failure → Redis retry queue)
  │  DB webhook (migrations 002/004) → Edge Function supabase/functions/process-review
  │  resolves DOI/Zenodo/landing pages → PDF → Gemini → writes status/result
  ▼
Scheduler "pdf-review-poll" (every 5 min)
  · status=done   → comment result + bot signature, distinguish (sticky optional), lock optional
  · status=failed → drop job, release the post lock
  · jobs > 1 h old are dropped; retry queue re-submits every 15 min, up to 3 attempts
```

## Layout

| Path | Purpose |
| --- | --- |
| `src/server/adversarial-reviewer.ts` | Menu, form and scheduler routes, plus the Redis queue logic |
| `src/server/adversarial-reviewer.test.ts` | Unit tests: gates, forms, Supabase queueing and retry, and the poller (FakeRedditWorld + spied `fetch`; no network) |
| `supabase/functions/process-review/` | Edge Function (Deno) and its URL-resolution helpers, with `node` tests run by `npm run test:supabase` |
| `supabase/migrations/001`–`008` | `review_jobs` table, webhook trigger, grants, and `subreddit_name`. The original numbering is kept to match the shared Supabase project's migration history |
| `supabase/prompts/adversarial_review_prompt.txt` | Live system prompt. It is served from Supabase Storage at `config/system_prompt.txt`, and an optional per-subreddit override can live at `config/system_prompt_<sub>.txt` |
| `supabase/config.toml` | Supabase CLI config, trimmed to the `process-review` function |

### Redis keys

| Key | Purpose |
| --- | --- |
| `bot:adversarial:lock:{postId}` | One review per post (7-day TTL). Released when a request is refused or a job fails or expires |
| `bot:adversarial:user:{userId}:{YYYY-MM-DD}` | Per-user daily quota (25 h TTL) |
| `bot:adversarial:pending-form:{userId}` | Post context held for 5 min while the user fills in a form |
| `bot:adversarial:pdfjobs` | Sorted set of post IDs waiting on Supabase |
| `bot:adversarial:retry-queue` | Sorted set of jobs Supabase rejected, scored by their next attempt time |

### Supabase deployment (manual)

The release workflow publishes only the Devvit app. Supabase changes are deployed by hand:

```sh
npx supabase db push                                   # migrations
npx supabase functions deploy process-review           # Edge Function (needs GEMINI_API_KEY secret in Supabase)
npx supabase storage cp supabase/prompts/adversarial_review_prompt.txt ss:///config/system_prompt.txt --experimental
```

The Devvit app reads `supabaseUrl`, `supabaseServiceRoleKey` (review jobs), and `supabaseServiceKey` (bot logs) from its global app settings.

> **Versioning:** No Devvit release of this app was recorded in this repo's source history (no tag, no release workflow run). `1.0.0` comes from the source `package.json` and is the baseline import version. Confirm it against the Devvit App Store before the first release.

---

## Local Commands

```sh
npm run check       # lint + typecheck + test + vite build
npm run lint        # ESLint
npm run typecheck   # tsc --noEmit
npm test            # Vitest (no Reddit login required)
npm run test:supabase  # node tests for the process-review Edge Function helpers
npm run build       # Vite build -> dist/server/index.cjs
npm run dev         # npx devvit playtest (requires Devvit login)
```

### No-Login Testing (`FakeRedditWorld` + `ScenarioRunner`)

`@devvit/test` (`createDevvitTest()`) isolates Redis, Settings, Scheduler, and Context in memory per test, while leaving Reddit Moderation, Listings, and Flair APIs unimplemented. `createModTest()` in `src/server/test-harness/` layers:

- **`FakeRedditWorld`:** stateful in-memory posts/comments and `vi.spyOn` handlers for `reddit.submitComment` and `reddit.remove`, plus a `.use(extension)` hook for adding module-specific spies (`getComments`, `getPostsByUser`, `getModerators`, `setUserFlair`, etc.).
- **`ScenarioRunner`:** calls `createApp().fetch(...)` directly against `/internal/triggers/*`, `/internal/menu/*`, and `/internal/forms/*`.

See `src/server/adversarial-reviewer.test.ts` for working examples.

---

## Required GitHub Secret (`DEVVIT_AUTH_TOKEN`)

The manual release workflow requires a repository (or organization) secret named **`DEVVIT_AUTH_TOKEN`** containing the **full raw contents** of your logged-in `~/.devvit/token` file:

```sh
npx devvit login
npx devvit whoami
gh secret set DEVVIT_AUTH_TOKEN < ~/.devvit/token
```

On Windows PowerShell:

```powershell
npx devvit whoami
Get-Content -LiteralPath (Join-Path $env:USERPROFILE '.devvit/token') -Raw |
  gh secret set DEVVIT_AUTH_TOKEN
```

> **Security & reliability note:** `DEVVIT_AUTH_TOKEN` is an undocumented CLI environment variable holding your personal Reddit OAuth refresh token — not a scoped CI service account. Keep it strictly on `master` release jobs (never PR workflows), rotate it if compromised, and note that it can expire or require re-login (`devvit login`) if Reddit invalidates sessions.

---

## Versioning & Release Process

### Versioning Rules

- **Strict 3-part SemVer only:** `MAJOR.MINOR.PATCH` (e.g. `1.2.0`). Never use 4-part versions or prerelease suffixes for releases.
- **Lockstep invariant:** Every release keeps four artifacts identical:
  1. `package.json` (`"version": "X.Y.Z"`)
  2. Git tag (`vX.Y.Z`)
  3. GitHub Release (`vX.Y.Z`)
  4. Devvit App Store (`X.Y.Z`)

### Running a Release

1. Merge all changes to `master` and wait for **CI** (`ci.yml`) to pass.
2. Open **Actions → Release Devvit app → Run workflow** on `master`:
   - **`bump`:** `patch`, `minor`, `major`, or `explicit`
   - **`version`:** only fill in when `bump` is `explicit` (e.g. `1.0.0`)
   - **`visibility`:** `unlisted` (default) or `public`
3. The workflow bumps `package.json` & `package-lock.json`, runs `npm run check`, authenticates via `DEVVIT_AUTH_TOKEN`, runs `npx --no devvit publish --version X.Y.Z` (with `DEVVIT_ALLOW_SOURCE_UPLOAD=1` and optional `--public`), commits + tags `vX.Y.Z` on `master`, creates GitHub Release `vX.Y.Z`, and asserts `tag == package.json == Devvit App Store version`.

> Note: `devvit publish` submits a version to Reddit's Developer Portal. Installing/upgrading on a subreddit (`devvit install`) and deploying any external Supabase migrations/functions remain separate steps.
