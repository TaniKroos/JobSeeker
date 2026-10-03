-- Keep as little user data as possible: facts and answers live in the user's AI assistant memory.
DROP TABLE IF EXISTS profiles;
DROP TABLE IF EXISTS answers;
ALTER TABLE applications DROP COLUMN next_step;
ALTER TABLE applications DROP COLUMN next_step_date;
ALTER TABLE applications DROP COLUMN notes;
CREATE INDEX IF NOT EXISTS applications_updated ON applications(updated_at);
CREATE INDEX IF NOT EXISTS ext_tokens_expires ON ext_tokens(expires_at);
