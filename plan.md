# JobsPilot v2 — Same-Day Job Radar

Turn JobsPilot from an on-demand search tool into an always-on watcher. It finds new postings at the source (company ATS boards) within minutes of publishing and pings you instantly. Claude then ranks them into the digest.

---

## 1. Why change

**Today**
- JobsPilot searches one company's careers board per call, only when Claude asks.
- The digest task checks ~27 companies, twice a day.
- Coverage is narrow, and a job posted at 9 AM may not show up until the 8 PM run.
- Aggregators (Indeed, LinkedIn, Naukri) are wider but typically 12–48 hours behind.

**Goal**
- Detect new relevant postings within **15–30 minutes** of publishing.
- Cover **300–500 companies** instead of 27.
- Instant alert for strong matches, plus a ranked digest twice a day.
- Stay on Cloudflare's free or $5 tier.

**Key idea:** every board copies from the company's ATS. Poll the ATS directly, remember which job IDs you've seen, and use *first seen by us* as the freshness clock instead of the posted date shown on boards.

---

## 2. Target architecture

```
          Cron (every 5 min)
                 |
         [ Poller Worker ]  -- shard of watchlist per tick
                 |
   Greenhouse / Lever / Ashby / SmartRecruiters / Workday / Workable
                 |
        normalize -> filter -> score
                 |
            [ D1: jobs ]  (new IDs only)
           /            \
  [ Notifier ]        [ JobsPilot MCP ]
  Telegram / email     new tools: get_new_jobs, ...
  (instant, score>=X)        |
                     Claude scheduled digest
                     (verify + rank, 8 AM / 8 PM)
```

The existing MCP tools stay as they are: search_jobs, get_job, track_application, get_open_forms and fill_form. v2 adds the poller, the store and a few read tools.

---

## 3. Components

### 3.1 Watchlist
- Table of companies: `name, ats, slug/tenant, site, priority, active`.
- Seed: NCR/Bangalore product companies, banks/fintech GCCs, Big Tech India, YC/AI startups hiring in India or remote.
- Build it by resolving each company's careers URL to its ATS. JobsPilot's board detection already does this, so reuse it.
- Priority tiers: P1 polled every cycle, P2 every other cycle.

### 3.2 ATS adapters (public, no auth)

| ATS | Endpoint | Freshness field |
|---|---|---|
| Greenhouse | `GET boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true` | `updated_at` / `first_published` |
| Lever | `GET api.lever.co/v0/postings/{slug}?mode=json` | `createdAt` (ms) |
| Ashby | `GET api.ashbyhq.com/posting-api/job-board/{slug}` | `publishedAt` |
| SmartRecruiters | `GET api.smartrecruiters.com/v1/companies/{id}/postings` | `releasedDate` |
| Workday | `POST {tenant}.wd{N}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs` | `postedOn` ("Posted Today") |
| Workable | `POST apply.workable.com/api/v3/accounts/{slug}/jobs` | `published` |
| Recruitee | `GET {slug}.recruitee.com/api/offers/` | `published_at` |

- Each adapter returns a common shape: `ext_id, company, title, location, remote, url, apply_url, posted_at, raw_hash`.
- For Workday, pass `searchText` (e.g. "engineer") and an India location facet to keep the response small. Sort by newest and stop paging once IDs are already seen.

### 3.3 Filter and score (in the Worker, cheap and rule-based)
- **Drop:** senior, lead, staff, principal, manager, architect, intern (configurable), and roles outside India unless remote-India.
- **Keep titles matching:** SDE / software engineer, backend, full-stack, AI / GenAI / LLM / ML engineer, agent, .NET / C#, Python, platform, forward-deployed / applied AI.
- **Location boost:** Gurugram/Noida/Delhi > Bangalore > remote-India > other India.
- **Stack boost:** .NET, C#, Python, FastAPI, TypeScript, Azure, LLM, RAG, MCP, agents.
- **Penalty:** Java-heavy, pure frontend, QA-only, data analyst.
- Output a `score` from 0 to 100. Experience years usually sit in the description, so parse "X+ years" with a regex where possible and leave final judgment to Claude.

### 3.4 Store (D1)

```sql
CREATE TABLE companies (
  id INTEGER PRIMARY KEY,
  name TEXT, ats TEXT, slug TEXT, site TEXT,
  priority INTEGER DEFAULT 2, active INTEGER DEFAULT 1,
  last_polled_at TEXT, last_error TEXT
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,            -- ats:slug:ext_id
  company_id INTEGER,
  title TEXT, location TEXT, remote INTEGER,
  url TEXT, apply_url TEXT,
  posted_at TEXT,                 -- from ATS (may be fuzzy)
  first_seen_at TEXT NOT NULL,    -- our freshness clock
  score INTEGER, exp_min INTEGER,
  status TEXT DEFAULT 'new',      -- new | notified | digested | dismissed
  raw_hash TEXT
);
CREATE INDEX idx_jobs_seen ON jobs(first_seen_at);
CREATE INDEX idx_jobs_status ON jobs(status, score);
```

- Insert with `INSERT OR IGNORE`. A new row means a new job.
- On the first poll of a newly added company, mark existing jobs `digested` so you aren't flooded with old postings.

### 3.5 Poller Worker
- Cron every 5 minutes. Each tick takes the next shard of companies (oldest `last_polled_at` first).
- Shard size is set by the subrequest limit: about 40 per tick on the free plan, more on the $5 Workers Paid plan. At ~40 per tick, 300 companies cycle about every 40 minutes, and P1 companies can be polled every tick.
- Option for scale: Cloudflare Queues (paid). Cron enqueues companies and consumers poll in parallel.
- Retry once on failure, store `last_error`, and back off companies that keep failing.
- Send a polite `User-Agent` and never poll a company more than every 5 minutes.

### 3.6 Notifier
- Telegram bot (`sendMessage`) for jobs with `score >= 70`. Example: *"Backend Engineer (GenAI) — Company — Gurugram — 1–3 yrs — first seen 12 min ago — link"*.
- Batch everything found in one tick into a single message. Quiet hours from 11 PM to 7 AM; those jobs queue for the morning.
- Optional email via an email API for an end-of-day summary.

### 3.7 New MCP tools
- `get_new_jobs(since?, min_score?, status?)` returns jobs first seen in a window, for the digest.
- `mark_jobs(ids, status)` marks jobs as digested, dismissed, etc.
- `watchlist_list()`, `watchlist_add(name or careers_url)`, `watchlist_remove(id)`.
- `radar_health()` reports companies polled in the last hour, error count and last run time.

---

## 4. Changes to the Claude digest task

The task's role changes from **searcher** to **analyst**:
1. Call `get_new_jobs(since = last 12h, min_score = 40)`.
2. Skip anything already in `list_applications`.
3. Open the top candidates (`get_job`) and confirm experience, location and stack.
4. Rank into "Strong match" and "Worth a look", then send the digest as today.
5. Call `mark_jobs(..., 'digested')`.
6. Optional: one quick web search pass for big names not yet on the watchlist, and suggest additions.

Same twice-daily schedule. Instant alerts already covered the time-critical part.

---

## 5. LinkedIn and Naukri (outside the radar)
- Not reachable through public endpoints. The ATS radar usually catches the original posting before it reaches these sites.
- Free: enable LinkedIn and Naukri job alerts. If Gmail is connected, the digest can parse alert emails.
- Paid and optional: an Apify LinkedIn scraper with a "past hour" filter. It's fragile, costs per run and goes against LinkedIn's terms, so leave it to last.

---

## 6. Rollout

| Phase | Scope | Done when |
|---|---|---|
| 1. Core | D1 schema, Greenhouse + Lever + Ashby adapters, cron poller, 50 companies | New jobs land in D1 within 30 min |
| 2. Alerts | Scoring rules, Telegram notifier, quiet hours | Strong matches ping the phone |
| 3. Coverage | Workday + SmartRecruiters + Workable adapters, watchlist to 300+ | Banks/GCCs and Big Tech covered |
| 4. MCP + digest | New MCP tools, rewire the scheduled task | Digest built from radar data |
| 5. Tune | Adjust weights from dismissed/applied feedback, health checks | Fewer than ~20% noise in alerts |

---

## 7. Risks and mitigations
- **ATS endpoint changes or blocks:** isolate per-adapter code, track `last_error`, alert when a company fails three cycles in a row.
- **Fuzzy posted dates (Workday):** rely on `first_seen_at`, not the board's date.
- **Reposted or edited jobs looking new:** dedupe on `company + normalized title + location` within 14 days, plus `raw_hash`.
- **Free-tier limits:** shard per tick. Move to Workers Paid ($5/mo) if the watchlist outgrows it.
- **Alert fatigue:** score threshold, batching, quiet hours, and dismiss feedback.

---

## 8. Success metrics
- Median time from posting to alert under 30 minutes.
- 300+ companies polled at least hourly.
- At least 80% of digest jobs first seen the same day.
- Applications sent within 24 hours of posting.