# Plan

## Status (3 Oct 2026)
Everything below is **implemented, tested and deployed** to https://jobs.smudgee.xyz, except the items marked ⏳:
- ✅ Newest-first job search with `posted_within_days` (default 30), `offset` paging, Workday location filtering on Workday's side, deeper SmartRecruiters reads.
- ✅ Multi-page fix: Next is clicked automatically on multi-step sites (no need for the assistant to ask), hints for stale tool lists, server logs for every fill, Workday widgets (listbox buttons, searchable prompts, "decline" on dropdowns that only show options when opened), auto-continue after the user fixes blocking fields, Review page reported as final. Tested on a 5-page Workday-style flow.
- ✅ Minimal data: profiles and answers tables dropped, applications trimmed to company/role/URL/status/applied date with 90-day retention (daily cron), no typed values sent, 1-hour room data, ticketed WebSocket (no token in URLs), `facts` from the assistant's memory used per request only, Google scopes `openid email`, dev passcode removed in production.
- ✅ Renamed to JobSeeker; logo, icons, social image.
- ✅ New home page, privacy policy, terms, sign-in windows (Google button, loading/error states, light/dark).
- ✅ Store build (`npm run zip:store -w apps/extension`), version 1.0.0, screenshots and promo tile in `store-assets/`, listing text in `docs/store-listing.md`.
- ⏳ Owner: create the Chrome Web Store developer account and submit (see "Publishing steps"); update the Google consent screen's app name to JobSeeker.
- ⏳ After approval: set `EXTENSION_IDS` and `CHROME_STORE_URL`, redeploy.
- ⏳ Live test of a full Workday / Oracle application past the first page (needs a real account on those sites).

## Decisions (3 Oct 2026)
- **Product name: JobSeeker** (replaces "Job Copilot" everywhere: extension, connector/MCP server name, website, Google consent screen, store listing). Before building icons and the listing, check the name for conflicts: Australia's government "JobSeeker Payment" and existing apps called JobSeeker; it may need a distinguishing tagline or variant in the store.
- **Support / contact email:** tanishsaini26@gmail.com (shown on /privacy, /terms, the home page and the store listing; set as `CONTACT_EMAIL`).
- **Governing law:** India, courts of Delhi.
- **Data:** keep as little as possible (see "Keep as little user data as possible").

## Job search: newest jobs first, filtered on the server

**Problem:** `search_jobs` returns at most 50 jobs (20 by default) and doesn't sort by date. Some boards are only read partly (Workday: first 80 results). Old postings can fill the results while newer ones never reach Claude.

**Goal:** Do the recency work on the server. Claude only gets current jobs, newest first, and can ask for more.

### Changes
1. **Normalize a posted date** on every `JobSummary` (`postedAt`, ISO date):
   | Board | Source field | Notes |
   |---|---|---|
   | Greenhouse | `first_published` (else `updated_at`) | Check that the list endpoint includes `first_published`; `updated_at` changes on any edit |
   | Lever | `createdAt` (ms) | |
   | Ashby | `publishedAt` | |
   | Workday | `postedOn` | Relative text ("Posted 3 Days Ago", "Posted 30+ Days Ago"). Parse it into a date and treat "30+" as older than 30 days |
   | Oracle | `PostedDate` | Already requested with `sortBy=POSTING_DATES_DESC` |
   | SmartRecruiters | `releasedDate` | |
   | Workable | `published` | |
   | Recruitee | `published_at` | |
2. **Sort newest first before applying `limit`**, on every board.
3. **New `search_jobs` parameter `posted_within_days`.** Drop older jobs on the server. Pick a default (e.g. 30), and let Claude widen it when nothing matches. Report how many were hidden as old.
4. **Paging:** add an `offset` parameter so Claude can fetch the next page instead of being stuck at 50.
5. **Read deeper where boards are paged:**
   - Workday: search by location on Workday's side (location facets) instead of filtering the first 80, and read more pages when needed.
   - SmartRecruiters: page past the first 100.
   - Stay under Cloudflare's 50 outgoing requests per call (free plan); paging covers the rest.
6. **Response:** always include `posted` on each job, plus `total`, `matching`, `returned`, `offset` and `older_hidden`, so Claude can tell the user there's more.
7. **Tests:** e2e checks that results are sorted newest first and that `posted_within_days` and `offset` work, on one board per type.

## Bug: Claude won't move through multi-page forms (Workday)

**What happened (3 Oct 2026):** On a Workday application, Claude filled the first page and then said:

> "I can't click through pages myself. Click Save and Continue, then say 'next' on each page and I'll fill it. The coming pages are usually My Experience, Application Questions and Voluntary Disclosures."

So the user still had to click Save and Continue and re-prompt on every page. This is the same problem as before the `advance` feature (Workday/Oracle were already stuck at "go to next page"). It should be: fill the page, click Save and Continue, fill the next page, and so on, stopping only at the final Review/Submit page.

**Likely causes (not yet confirmed):**
1. **Stale tool list in Claude.** The connector wasn't reconnected after the deploy, so Claude still had the old `fill_form` (no `advance` parameter) and the old instructions ("the user clicks Next"). The wording "I can't click through pages myself" fits this.
2. **Claude chose not to use `advance`.** The instructions say to ask the user first; Claude may have skipped asking and fallen back to manual.
3. **Advance was blocked.** Workday's first page has required custom widgets ("How did you hear about us?" multi-select, country/state pickers, phone device type). If any required field didn't fill, the extension refuses to click Next. Claude should then name the fields, but it didn't.

**Fixes to make:**
1. **Diagnose first:** log every `fill_form` on the server (form site, step, advance requested yes/no, clicked or blocked, blocking fields) to Cloudflare logs, so we can see which cause it was. Retry with `npx wrangler tail` running.
2. **Don't depend on Claude choosing it:** store a profile preference (`auto_advance: true`, the default). For multi-step sites (Workday, Oracle, SuccessFactors, Taleo, iCIMS), the server then clicks Next after a clean fill even if Claude doesn't pass `advance`.
3. **Stale-client fallback:** return a visible hint in `get_open_forms` and `fill_form` responses ("this form has more pages; Job Copilot moves to the next page automatically, so don't ask the user to click"). That way even an old tool schema gets the message.
4. **Workday widgets:** test the full Workday flow on a live posting (sign-in/create account → My Information → My Experience → Application Questions → Voluntary Disclosures → Self Identify → Review). Make the multi-select prompt, date pickers and country/state dropdowns fill reliably, so advance isn't blocked.
5. **When blocked, say exactly what's needed:** the response must name the fields, and the pill should show "Needs you: …" with Next field ›. After the user fixes them, the extension clicks Next itself (watch for the fields to become valid) instead of waiting for the user.
6. **Test:** a browser test on a fake 5-page Workday-style flow where Claude never passes `advance`, checking it still reaches the Review page and stops before Submit.

## Keep as little user data as possible

**Decision (3 Oct 2026):** the server keeps only what it needs to work. Facts about the user (profile, past answers) live in the AI assistant's own memory (Claude or ChatGPT memory), not on our server.

### What we keep
| Data | Keep | Retention |
|---|---|---|
| `users` | id, email, Google account id, created_at | Until the user deletes their account |
| `applications` | id, user_id, company, role, url, status, applied_at (+ updated_at, needed for the 90-day rule) | **Deleted 90 days after last update** |
| Extension sign-in | Hashed token only | 90 days |
| Connector sign-in (KV) | OAuth grants/tokens (library-encrypted) | Library TTLs |
| Open application form | Questions, options, required flags, URL, company, role. **No typed values.** | **1 hour**, or until the tab closes |
| Job page without a form | URL, title, company, role, apply link | 1 hour |

### What we stop keeping
- **`profiles` table:** dropped. Remove `get_profile` / `update_profile`. Claude uses its memory and asks the user for missing facts.
- **`answers` table:** dropped. Remove `find_saved_answers` / `save_answer` / `delete_saved_answer`. The extension stops sending submitted answers.
- **`applications` columns:** drop `next_step`, `next_step_date`, `notes`. Remove those fields from `track_application` / `update_application`. Claude keeps any notes in its memory.
- **Typed field values** in captured forms: the extension sends only whether a field is empty or not.
- **"Page moved" pointers** in the room: give them the same 1-hour lifetime.

### Keep the speed without storing facts
Server-side suggestions currently come from the stored profile. Instead, `get_open_forms` and `fill_form` take an optional `facts` object that Claude fills from its memory (name, email, phone, sponsorship…). The server uses it **only for that request** to match fields and fill dropdowns, and never saves it. "Decline" suggestions for EEO questions stay, since they need no user data.

### Other changes
1. **Extension token out of URLs:** the extension asks `POST /ext/ws-ticket` (Bearer token) for a single-use, 60-second ticket and connects with `?ticket=`, so the real token never appears in Cloudflare request logs.
2. **90-day cleanup:** a daily Cron Trigger deletes old applications, expired extension tokens and stale room data. Reads also skip expired rows.
3. **Google sign-in scopes:** `openid email` only (drop `profile`; we don't need the name or photo).
4. **Dev passcode login:** remove once Google sign-in works.
5. **Migration:** D1 migration `0002` drops `profiles` and `answers` and the three `applications` columns (current data: 3 applications, whose notes are deleted).
6. **Update** `delete_my_data`, the instructions given to Claude (use memory; ask, then remember), the `/privacy` page, and the README.
7. **Tests:** e2e checks that no profile, answers or typed values reach the server, that `facts` suggestions work, that 90-day expiry works (backdated row), and the ticket-based WebSocket.

### Trade-offs we accept
- If the user turns memory off, or switches between Claude and ChatGPT, the assistant has to ask for facts again.
- Long answers ("Why this company?") aren't reused automatically unless the assistant remembers them.
- After 90 days, old applications disappear from the tracker. The user can export them first with `export_applications`.

## Chrome Web Store release

**Goal:** publish the extension, Unlisted first (people with the link can install it), Public later.

### Fix before submitting
1. **Icons:** add 16, 32, 48 and 128 px icons (the store requires 128×128) in `apps/extension/public/icon/`, wired into the manifest.
2. **Store-only build:** host permissions only for `https://jobs.smudgee.xyz/*` plus the job sites. Drop `http://localhost/*` and `https://*.workers.dev/*`, keeping them in dev builds only. Reviewers flag permissions the extension doesn't need.
3. **Leave out the all-sites permission** (`optional_host_permissions: <all_urls>` and the "Work on every career site" toggle) for the first submission. It triggers a slower, in-depth review; add it back in an update.
4. **Name → "JobSeeker"** (see Decisions). "Copilot" is a Microsoft trademark and risks rejection or a later takedown. Rename before making icons and listing assets; update the extension, connector, website and Google consent screen together.
5. **Version** `1.0.0`; production default server `https://jobs.smudgee.xyz` (already set via `.env`).
6. **Zip:** `npm run zip -w apps/extension` → `.output/*-chrome.zip`.
7. **Listing assets:** at least one 1280×800 screenshot (a filled application with the pill; the popup), a 440×280 small promo tile, and a short and full description.
8. **Privacy practices answers** (write them in `docs/store-listing.md` so they can be pasted in):
   - Single purpose: fill job application forms with answers from the user's AI assistant, and track applications.
   - Reason for each permission: `storage` (sign-in state), `identity` (Google sign-in), `scripting` + `activeTab` ("Use on this page"), host permissions (read/fill application forms on job sites; talk to jobs.smudgee.xyz).
   - Remote code: none.
   - Data collected: personally identifiable information (email), website content (form questions). Not sold, not used for unrelated purposes or creditworthiness.
   - Privacy policy: `https://jobs.smudgee.xyz/privacy`.

### Publishing steps (owner)
1. Developer account at https://chrome.google.com/webstore/devconsole: one-time $5 fee, 2-step verification, publisher details, non-trader declaration.
2. New item → upload the zip → Store listing → Privacy practices → Distribution: **Unlisted** → Submit for review (usually a few days).

### After approval
- Set `EXTENSION_IDS` on the Worker to the store extension ID (plus the local unpacked ID for development), so only the official extension can sign in.
- For updates: bump the version → zip → upload → review.

## Website and sign-in pages polish

**Goal:** jobs.smudgee.xyz looks like a real product: clear, trustworthy, and consistent with the new name. Needed for the Chrome Web Store, Google's consent screen and sharing with users.

### Home page (`/`)
- One-line hero ("Your AI assistant fills job applications. You review and submit."), the logo, and two buttons: **Add to Chrome** (store link) and **Connect to Claude / ChatGPT** (shows the connector URL with a copy button).
- "How it works" in 3 steps with screenshots: find jobs in Claude → open the application → "fill it", review, submit.
- Supported job sites (Greenhouse, Lever, Ashby, Workday, Oracle, SmartRecruiters, Workable, …).
- **Privacy promise in plain words:** we keep only your email and a 90-day list of applications; your details stay in your AI assistant's memory; nothing is submitted without you.
- Short FAQ (Is it free? Does it submit for me? What data do you keep? Which AI assistants work?).
- Footer: Privacy · Terms · Contact. Favicon, social-share preview tags, dark mode, works at phone width.

### Privacy policy (`/privacy`)
- Rewrite for the minimal-data plan: a table of what we keep (account email and Google ID; applications with company, role, URL, status and applied date for 90 days; open form questions for 1 hour, no typed values) and what we don't (profile, answers, résumés, passwords, email or Drive contents).
- Who processes data: Cloudflare (hosting). The user's AI provider (Anthropic or OpenAI) receives tool results under its own policy.
- **Google API Services User Data Policy / Limited Use** statement for the Google sign-in data, and the matching Chrome Web Store Limited Use statement.
- Retention table, security measures, cookies (sign-in only), not for under-18s.
- User rights under India's DPDP Act (access, correction, deletion, grievance): **contact or grievance email** (still needed: e.g. support@smudgee.xyz) and how to delete data (`delete_my_data`, or email).
- Effective date and how changes are announced.

### Terms (`/terms`)
- Eligibility (18+), free early-access service provided "as is".
- The user is responsible for everything submitted; AI answers can be wrong, so always review.
- Acceptable use: no false information, no applying for others without permission, respect job sites' terms, no abuse or automation at scale.
- No guarantee of interviews or jobs; third-party job sites and AI assistants aren't ours.
- Suspension, changes to the service, limitation of liability, governing law (India, courts of **Delhi**), and contact (tanishsaini26@gmail.com).

### Sign-in window (the page that opens when connecting Claude or the extension)
- New name and logo at the top. Clear title: "Connect JobSeeker to Claude" / "Connect the Chrome extension".
- Show **which app is asking** (client name, verified domain) and **what it can do**, as a plain list (search jobs, read and fill application forms in your browser, keep your application list), plus a link to the privacy policy.
- **Google button per Google's branding guidelines** (official "G" mark, "Continue with Google", standard colours), as the only option. **Remove the dev passcode form in production** (keep it local-only).
- Loading state after clicking (so people don't double-click), friendly error pages with a **Try again** button instead of plain text, and a "Connected, you can close this window" success state for the extension window.
- Fits the extension's small sign-in window (~500 px wide), keyboard-accessible, dark mode.
