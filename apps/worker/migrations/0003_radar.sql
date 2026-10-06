-- Job radar: poll a watchlist of company job boards and remember which job ids we've seen.
-- Companies and jobs are public postings shared by everyone; only job_marks is per user.

CREATE TABLE companies (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  ats TEXT NOT NULL, -- greenhouse | lever | ashby | workday | oracle | smartrecruiters | workable | recruitee | bain
  board TEXT NOT NULL, -- the board slug, as in a job_ref (workday: host/tenant/site)
  priority INTEGER NOT NULL DEFAULT 2, -- 1: every 30 min, 2: hourly, 3: every 2 hours
  active INTEGER NOT NULL DEFAULT 1,
  opts TEXT, -- JSON adapter options (e.g. a Workday location facet)
  seen_ids TEXT, -- JSON array of job ids on the board at the last poll; NULL until the first poll
  etag TEXT,
  body_hash TEXT,
  job_count INTEGER,
  last_polled_at INTEGER,
  last_changed_at INTEGER,
  last_error TEXT,
  fail_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE (ats, board)
);

-- Only jobs that appeared after a company's first poll; kept 30 days.
CREATE TABLE jobs (
  id TEXT PRIMARY KEY, -- ats:board:ext_id, the same as a job_ref
  company_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT '',
  remote INTEGER NOT NULL DEFAULT 0,
  url TEXT,
  apply_url TEXT,
  posted_at TEXT, -- from the board, when it says (may be fuzzy)
  first_seen_at INTEGER NOT NULL, -- our freshness clock
  score INTEGER NOT NULL DEFAULT 0,
  reject TEXT, -- why the rules scored it 0
  dedupe_key TEXT, -- normalized title|location, to spot reposts
  notified_at INTEGER
);
CREATE INDEX jobs_seen ON jobs(first_seen_at);
CREATE INDEX jobs_company ON jobs(company_id, first_seen_at);

-- What each user did with a radar job (digested / dismissed / applied).
CREATE TABLE job_marks (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL,
  status TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, job_id)
);

CREATE TABLE radar_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
