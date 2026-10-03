# Job Copilot

Find jobs, fill applications and track them from Claude (or ChatGPT). Claude writes the answers; a Chrome extension types them into the application page; you review and click Submit.

```
Claude / ChatGPT ──MCP──► Cloudflare Worker ◄──WebSocket── Chrome extension ──► application page
                          • job search (Greenhouse, Lever, Ashby, Workday, SmartRecruiters, Workable, Recruitee, Oracle; any job page via JSON-LD)
                          • profile + answer bank + tracker (D1)
                          • one room per user (Durable Object) routing fills to the right tab
```

| Folder | What |
|---|---|
| `apps/worker` | Cloudflare Worker: MCP server (`/mcp`), OAuth for the connector, extension sign-in and WebSocket, D1 schema |
| `apps/extension` | Chrome extension (WXT, Manifest V3): captures forms, fills them, detects submit |
| `packages/shared` | Types shared by both |

Requires **Node 22+** (`nvm use`).

## Run locally

```sh
npm install
cd apps/worker
npm run db:migrate:local
npm run dev                      # http://localhost:8787, uses .dev.vars (DEV_PASSCODE=letmein)
```

In another terminal:

```sh
npm run build -w apps/extension  # → apps/extension/.output/chrome-mv3
```

Load the extension: `chrome://extensions` → Developer mode → **Load unpacked** → `apps/extension/.output/chrome-mv3`. Click the extension icon → **Connect** → sign in with any email + passcode `letmein`.

### Tests

```sh
cd apps/worker && npm run e2e                        # OAuth, extension login, every tool and board, suggestions, multi-page, user isolation
cd apps/extension && node scripts/browser-test.mjs   # real Chromium + extension on live Greenhouse/Lever/Ashby pages (never submits) + submit detection
cd apps/extension && node scripts/flow-test.mjs      # multi-page advance, blocked Next, job page → Apply, "any website" mode (fake pages)
```

Both need `npm run dev` running in `apps/worker`.

## Deploy (Cloudflare free plan)

```sh
cd apps/worker
npx wrangler login
npx wrangler deploy                              # creates the KV namespace and D1 database on first deploy
npm run db:migrate:remote
npx wrangler secret put SESSION_SECRET           # any long random string: openssl rand -base64 32
npx wrangler secret put DEV_PASSCODE             # optional: passcode sign-in for testing (set DEV_EMAILS in wrangler.jsonc to lock it to your email)
```

Your server is `https://job-copilot.<your-subdomain>.workers.dev`.

- **Claude:** Settings → Connectors → Add custom connector → `https://job-copilot.<your-subdomain>.workers.dev/mcp`
- **ChatGPT:** Settings → Apps & Connectors → Developer mode → add the same URL
- **Extension:** popup → Settings → Server URL → your workers.dev URL → Save → Connect

### Google sign-in (for other users)

1. Google Cloud Console → new project → **APIs & Services → OAuth consent screen**: External, scopes `openid`, `email`, `profile` only (non-sensitive, no security review).
2. **Credentials → Create OAuth client → Web application**, authorized redirect URIs:
   - `https://<your-worker>/auth/google/callback` (Claude/ChatGPT connector)
   - `https://<your-worker>/ext/google/callback` (extension)
   - same two with `http://localhost:8787` for local dev
3. `npx wrangler secret put GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (locally: `.dev.vars`).
4. Remove `DEV_PASSCODE` once Google works.

## MCP tools

`search_jobs`, `get_job`, `get_profile`, `update_profile`, `find_saved_answers`, `save_answer`, `delete_saved_answer`, `get_open_forms`, `fill_form`, `wait_for_next_page`, `track_application`, `update_application`, `list_applications`, `delete_application`, `export_applications` (CSV; Claude can save it to Google Drive with its own Drive connector), `delete_my_data`.

**Finding a company's jobs:** no company is hardcoded. `search_jobs` takes a name (guesses Greenhouse/Lever/Ashby/SmartRecruiters/Workable/Recruitee slugs, then tries `example.com/careers`-style pages) or any URL: a careers page (the board it embeds or links to is detected), a board, or a single job posting. When a name isn't enough it tells Claude what to web-search for.

## How filling works

1. On a supported site (Greenhouse, Lever, Ashby, Workday, Google Forms, or any page after **Use on this page**) the content script reads every field (label, kind, options, required) and tags it with `data-jc-id`.
2. The background worker sends the form to the user's room over a WebSocket. It only connects while an application page is open, and pings every 20s.
3. Claude calls `get_open_forms` → `fill_form`. Fields the server can answer from the profile/saved answers come with a `suggested` value and are filled automatically, so Claude only writes the new answers. The room forwards the answers to the browser that owns the form; the content script fills each field like a user would (native value setter, key events, clicking options) and highlights it yellow, or red if it needs you.
4. Dropdowns and autocompletes match exactly or at a word boundary only. When nothing matches, the result lists the real options so Claude can retry with an exact one.
5. Multi-step forms: `fill_form` with `advance: true` clicks Next/Continue (never Submit) and returns the next page in the same call; if the page refuses (validation), the response says which fields. If the user clicks Next themselves, `wait_for_next_page` returns the new page.
6. On a job description page the pill offers **Open application**, and Claude is told the user still has to click Apply.
7. When you submit and a thank-you page appears, the application is marked **Applied** and long answers are saved to your answer bank.

## Known gaps

- **Resume upload is manual.** Browsers don't let extensions attach local files.
- **Google Forms, Workday, Oracle, iCIMS, Taleo** forms are captured with the generic reader but haven't been tested on live forms past the first page; their custom widgets may need work.
- Naukri and LinkedIn job search aren't supported (don't scrape them).
- "Work on every career site" (popup) asks Chrome for access to all sites; the Chrome Web Store reviews that permission more strictly.
- The answer bank uses keyword search, not semantic search.
- The extension has no icon yet.
