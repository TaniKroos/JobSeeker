CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  google_sub TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE ext_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX ext_tokens_user ON ext_tokens(user_id);

CREATE TABLE profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data TEXT NOT NULL, -- JSON object of facts (name, phone, notice period, links…)
  updated_at INTEGER NOT NULL
);

CREATE TABLE answers (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  source TEXT NOT NULL, -- "claude" | "submitted"
  updated_at INTEGER NOT NULL
);
CREATE INDEX answers_user ON answers(user_id);

CREATE TABLE applications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company TEXT NOT NULL,
  role TEXT NOT NULL,
  url TEXT,
  status TEXT NOT NULL, -- Interested | Applying | Applied | OA | Interview | Offer | Rejected | Withdrawn
  applied_at INTEGER,
  next_step TEXT,
  next_step_date TEXT, -- YYYY-MM-DD
  notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX applications_user ON applications(user_id, updated_at);
