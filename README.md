# JobSeeker

Your AI assistant (Claude or ChatGPT) fills job applications in your browser. You review and submit. Live at **https://jobs.smudgee.xyz**.

```
Claude / ChatGPT ──MCP──► Cloudflare Worker ◄──WebSocket── Chrome extension ──► application page
                          • job search: Greenhouse, Lever, Ashby, Workday, SmartRecruiters,
                            Workable, Recruitee, Oracle; any job page (JSON-LD)
                          • users + a 90-day application list (D1)
                          • one room per user (Durable Object) routing fills to the right tab
```

| Folder | What |
|---|---|
| `apps/worker` | Cloudflare Worker: MCP server (`/mcp`), Google sign-in for the connector and the extension, extension WebSocket, website (`/`, `/privacy`, `/terms`), daily cleanup cron |
| `apps/extension` | Chrome extension (WXT, Manifest V3): captures forms, fills them, clicks Next on multi-page forms, detects submit |
| `packages/shared` | Types shared by both |
| `assets/logo.svg` | Logo source; `apps/extension/scripts/make-assets.mjs` renders the icons and social image |
| `store-assets/`, `docs/store-listing.md` | Chrome Web Store images and listing text |
| `plan.md` | Decisions and roadmap |

Requires **Node 22+** (`nvm use`).

## Data we keep (on purpose, very little)

| Data | Retention |
|---|---|
| `users`: email, Google account ID | until the user asks for deletion |
| `applications`: company, role, URL, status, applied date | 90 days after last update (daily cron + filtered on read) |
| extension sign-in (hashed token) | 90 days |
| open form questions in the user's room (labels/options/answered?, never typed values) | 1 hour (Durable Object alarm) |
| `job_marks`: which radar jobs a user marked digested/dismissed/applied | 30 days |

The radar's `companies` and `jobs` tables hold public postings only (shared, not per user); `jobs` are kept 30 days.

No profile and no saved answers: facts about the user live in the assistant's memory and are passed as `facts` with `get_open_forms` / `fill_form`, used for that request only. `delete_my_data` erases the tracker, radar marks and extension sign-ins.

## Run locally

```sh
npm install
cd apps/worker
npm run db:migrate:local
npm run dev                      # http://localhost:8787 (.dev.vars: DEV_PASSCODE=letmein, Google keys)
```

To try the radar locally, start dev with `npx wrangler dev --test-scheduled --var RADAR_OWNER_EMAIL:radar-owner@example.com` and run a tick with `curl "http://localhost:8787/__scheduled?cron=*/30+*+*+*+*"`.

```sh
npm run build -w apps/extension  # dev build → apps/extension/.output/chrome-mv3
```

Load it at `chrome://extensions` → Developer mode → **Load unpacked**. The dev build's popup has "Developer settings" to point it at `http://localhost:8787`.

### Tests (with `npm run dev` running)

```sh
cd apps/worker && npm run e2e                        # sign-in, ticketed WebSocket, every tool and job board, recency/paging,
                                                      # facts suggestions, multi-page advance, 90-day expiry, isolation, delete,
                                                      # radar (needs the --test-scheduled dev command above; resets local radar state)
cd apps/extension && node scripts/flow-test.mjs      # real Chromium + extension: 2- and 5-page Workday-style flows (auto Next,
                                                      # blocked by résumé then auto-continue, Review page), job page → Apply, any-site mode
cd apps/extension && node scripts/browser-test.mjs   # live Greenhouse/Lever/Ashby forms (never submits) + submit detection
node scripts/make-screenshots.mjs                     # website + store screenshots from a demo application
```

## Deploy

```sh
cd apps/worker
npx wrangler deploy               # Worker + static files (public/) + daily cron + 30-minute radar cron
npm run db:migrate:remote
```

Radar secrets: `RADAR_OWNER_EMAIL` (your sign-in email; only it may change the watchlist), and for instant alerts `TELEGRAM_BOT_TOKEN` (from @BotFather) and `TELEGRAM_CHAT_ID` (message the bot, then read `chat.id` from `https://api.telegram.org/bot<token>/getUpdates`). Without the Telegram secrets the radar still runs and fills `get_new_jobs`; it just doesn't alert.

Secrets: `SESSION_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (`npx wrangler secret put …`). Production has no `DEV_PASSCODE`, so only Google sign-in is offered. Vars in `wrangler.jsonc`: `PUBLIC_URL` (empty = own origin), `EXTENSION_IDS` (lock sign-in to the store extension), `CHROME_STORE_URL` (home page "Add to Chrome").

Google OAuth client (Web): redirect URIs `https://jobs.smudgee.xyz/auth/google/callback` and `/ext/google/callback` (+ the same on `http://localhost:8787`); scopes `openid email`.

## Chrome Web Store

```sh
npm run zip:store -w apps/extension   # → apps/extension/.output/jobseeker-1.0.0-chromestore.zip
```

The store build only talks to `jobs.smudgee.xyz` and has no optional all-sites permission. Listing text, permission justifications and privacy answers: [docs/store-listing.md](docs/store-listing.md).

## MCP tools

`search_jobs` (newest first, `posted_within_days` default 30, `offset` paging), `get_job` (any job URL), `get_open_forms`, `fill_form` (fills `suggested` values from `facts`; clicks Next on multi-step sites by default, never Submit), `wait_for_next_page`, `track_application`, `update_application`, `list_applications`, `delete_application`, `export_applications` (CSV), `delete_my_data`.

Job radar (`src/radar`): `get_new_jobs`, `mark_jobs`, `watchlist_list`, `watchlist_add`, `watchlist_remove`, `radar_health`. A 30-minute cron polls the watchlist (~114 boards seeded in `migrations/0004_radar_seed.sql` and `0005_radar_p1.sql`; priority 1/2/3 = every 30/60/120 min, as capacity allows: ~42 boards per run), stores only jobs that appear after a board's first poll ("first seen" is the freshness clock), scores them on title and location (`src/radar/score.ts`) and sends one batched Telegram message for scores ≥ 70 outside quiet hours (23:00–07:00 IST). It's sized for the Workers Free plan: ≤ 48 subrequests per tick, lightweight endpoints (Lever's HTML list, Ashby's GraphQL, Greenhouse with ETags), and a cap on bytes parsed per tick; raise `RADAR_*` in `wrangler.jsonc` on Workers Paid.

No company is hardcoded in search: `search_jobs` guesses board slugs from a name, tries `example.com/careers`-style pages, detects the board behind any careers page or single job URL, and otherwise tells the assistant what to web-search for.

## How filling works

1. On a supported site (or after **Use on this page**) the content script reads every field (label, kind, options, required, answered or not) and tags it with `data-jc-id`. Workday listbox buttons and searchable prompts are supported.
2. The background worker trades its token for a 60-second ticket and opens a WebSocket to the user's room (only while a job page is open; ping every 20 s).
3. `get_open_forms` returns the fields with `suggested` values matched from `facts` (and "decline" for voluntary EEO questions). `fill_form` sends them plus the assistant's answers; the extension fills like a user (native setters, key events, clicking options), highlighting fields yellow, or red if they need the user.
4. Multi-step sites (Workday, Oracle, SuccessFactors, Taleo, iCIMS): after a clean fill the extension clicks Next/Continue and the response includes the next page. If required fields block it (e.g. résumé upload), the pill shows what's needed and the extension continues by itself once they're done. The Review page is reported as final; nothing is ever submitted.
5. Job description pages: the pill offers **Open application**, and the assistant is told the user still has to click Apply.
6. When a thank-you page follows Submit, the application is marked **Applied**.

## Known gaps

- Résumé upload is manual (browsers don't let extensions attach local files).
- Workday and Oracle flows are tested on realistic fakes and on Workday's first pages; complex widgets on some tenants (date pickers, multi-level prompts) may still need work.
- Naukri and LinkedIn aren't supported (don't scrape them).
- The radar reads titles and locations only, so experience requirements are checked by the assistant (`get_job`) during the digest. Big Tech with in-house career sites (Google, Microsoft, Amazon) and McKinsey (blocks automated access) can't be polled.
