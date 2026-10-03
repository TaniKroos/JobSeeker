// D1 access: users, extension tokens, profile, answer bank and the application tracker.

export const now = () => Date.now();
export const newId = () => crypto.randomUUID();

export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomToken(bytes = 32): string {
  const arr = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...arr)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ---------- users ----------

export interface User {
  id: string;
  email: string;
}

export async function upsertUser(db: D1Database, email: string, googleSub?: string): Promise<User> {
  const normalized = email.trim().toLowerCase();
  const existing = await db.prepare("SELECT id, email FROM users WHERE email = ?").bind(normalized).first<User>();
  if (existing) {
    if (googleSub) await db.prepare("UPDATE users SET google_sub = ? WHERE id = ?").bind(googleSub, existing.id).run();
    return existing;
  }
  const user = { id: newId(), email: normalized };
  await db
    .prepare("INSERT INTO users (id, email, google_sub, created_at) VALUES (?, ?, ?, ?)")
    .bind(user.id, user.email, googleSub ?? null, now())
    .run();
  return user;
}

// ---------- extension tokens ----------

const EXT_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export async function createExtToken(db: D1Database, userId: string): Promise<string> {
  const token = randomToken();
  await db
    .prepare("INSERT INTO ext_tokens (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256Hex(token), userId, now(), now() + EXT_TOKEN_TTL_MS)
    .run();
  return token;
}

export async function userForExtToken(db: D1Database, token: string): Promise<User | null> {
  return db
    .prepare(
      `SELECT u.id, u.email FROM ext_tokens t JOIN users u ON u.id = t.user_id
       WHERE t.token_hash = ? AND t.expires_at > ?`,
    )
    .bind(await sha256Hex(token), now())
    .first<User>();
}

export async function revokeExtToken(db: D1Database, token: string): Promise<void> {
  await db.prepare("DELETE FROM ext_tokens WHERE token_hash = ?").bind(await sha256Hex(token)).run();
}

// ---------- profile ----------

export async function getProfile(db: D1Database, userId: string): Promise<Record<string, unknown>> {
  const row = await db.prepare("SELECT data FROM profiles WHERE user_id = ?").bind(userId).first<{ data: string }>();
  return row ? JSON.parse(row.data) : {};
}

// Merge `patch` into the profile; keys set to null are removed.
export async function updateProfile(
  db: D1Database,
  userId: string,
  patch: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const profile = await getProfile(db, userId);
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete profile[k];
    else profile[k] = v;
  }
  await db
    .prepare(
      `INSERT INTO profiles (user_id, data, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
    )
    .bind(userId, JSON.stringify(profile), now())
    .run();
  return profile;
}

// ---------- answer bank ----------

export interface SavedAnswer {
  id: string;
  question: string;
  answer: string;
  source: string;
  updated_at: number;
}

const normalizeQuestion = (q: string) => q.trim().replace(/\s+/g, " ").replace(/\s*\*$/, "");

export async function saveAnswer(
  db: D1Database,
  userId: string,
  question: string,
  answer: string,
  source: "claude" | "submitted",
): Promise<string> {
  const q = normalizeQuestion(question);
  const existing = await db
    .prepare("SELECT id FROM answers WHERE user_id = ? AND lower(question) = lower(?)")
    .bind(userId, q)
    .first<{ id: string }>();
  if (existing) {
    await db
      .prepare("UPDATE answers SET answer = ?, source = ?, updated_at = ? WHERE id = ?")
      .bind(answer, source, now(), existing.id)
      .run();
    return existing.id;
  }
  const id = newId();
  await db
    .prepare("INSERT INTO answers (id, user_id, question, answer, source, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, userId, q, answer, source, now())
    .run();
  return id;
}

const STOPWORDS = new Set(
  "a an and are as at be by do does for from have how i in is it me of on or our tell the this to us what when where which who why will with would you your".split(
    " ",
  ),
);

// Rank saved answers by keyword overlap with the query.
export async function searchAnswers(db: D1Database, userId: string, query: string, limit = 5): Promise<SavedAnswer[]> {
  const { results } = await db
    .prepare("SELECT id, question, answer, source, updated_at FROM answers WHERE user_id = ? ORDER BY updated_at DESC LIMIT 500")
    .bind(userId)
    .all<SavedAnswer>();
  const words = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
  if (!words.length) return results.slice(0, limit);
  return results
    .map((a) => {
      const hay = a.question.toLowerCase();
      return { a, score: words.filter((w) => hay.includes(w)).length };
    })
    .filter((x) => x.score > 0)
    .sort((x, y) => y.score - x.score || y.a.updated_at - x.a.updated_at)
    .slice(0, limit)
    .map((x) => x.a);
}

export async function deleteAnswer(db: D1Database, userId: string, id: string): Promise<boolean> {
  const r = await db.prepare("DELETE FROM answers WHERE id = ? AND user_id = ?").bind(id, userId).run();
  return r.meta.changes > 0;
}

// ---------- application tracker ----------

export const STATUSES = ["Interested", "Applying", "Applied", "OA", "Interview", "Offer", "Rejected", "Withdrawn"] as const;
export type Status = (typeof STATUSES)[number];

export interface Application {
  id: string;
  company: string;
  role: string;
  url: string | null;
  status: Status;
  applied_at: number | null;
  next_step: string | null;
  next_step_date: string | null;
  notes: string | null;
  created_at: number;
  updated_at: number;
}

export interface ApplicationInput {
  company: string;
  role: string;
  url?: string;
  status?: Status;
  next_step?: string | null;
  next_step_date?: string | null;
  notes?: string | null;
}

const urlKey = (url: string) => {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname.replace(/\/(apply|application)\/?$/, "").replace(/\/$/, "")}`;
  } catch {
    return url;
  }
};

async function findExisting(db: D1Database, userId: string, input: ApplicationInput): Promise<Application | null> {
  if (input.url) {
    const { results } = await db
      .prepare("SELECT * FROM applications WHERE user_id = ? AND url IS NOT NULL")
      .bind(userId)
      .all<Application>();
    const key = urlKey(input.url);
    const hit = results.find((a) => a.url && urlKey(a.url) === key);
    if (hit) return hit;
  }
  return db
    .prepare("SELECT * FROM applications WHERE user_id = ? AND lower(company) = lower(?) AND lower(role) = lower(?)")
    .bind(userId, input.company.trim(), input.role.trim())
    .first<Application>();
}

// Create the application, or update it if the same job (by URL, else company + role) is already tracked.
export async function upsertApplication(
  db: D1Database,
  userId: string,
  input: ApplicationInput,
): Promise<{ app: Application; created: boolean }> {
  const existing = await findExisting(db, userId, input);
  const t = now();
  if (existing) {
    const status = input.status ?? existing.status;
    const appliedAt = existing.applied_at ?? (status === "Applied" ? t : null);
    await db
      .prepare(
        `UPDATE applications SET url = ?, status = ?, applied_at = ?, next_step = ?, next_step_date = ?, notes = ?, updated_at = ?
         WHERE id = ?`,
      )
      .bind(
        input.url ?? existing.url,
        status,
        appliedAt,
        input.next_step !== undefined ? input.next_step : existing.next_step,
        input.next_step_date !== undefined ? input.next_step_date : existing.next_step_date,
        input.notes !== undefined ? input.notes : existing.notes,
        t,
        existing.id,
      )
      .run();
    return { app: (await getApplication(db, userId, existing.id))!, created: false };
  }
  const id = newId();
  const status = input.status ?? "Interested";
  await db
    .prepare(
      `INSERT INTO applications (id, user_id, company, role, url, status, applied_at, next_step, next_step_date, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      userId,
      input.company.trim(),
      input.role.trim(),
      input.url ?? null,
      status,
      status === "Applied" ? t : null,
      input.next_step ?? null,
      input.next_step_date ?? null,
      input.notes ?? null,
      t,
      t,
    )
    .run();
  return { app: (await getApplication(db, userId, id))!, created: true };
}

export async function getApplication(db: D1Database, userId: string, id: string): Promise<Application | null> {
  return db.prepare("SELECT * FROM applications WHERE id = ? AND user_id = ?").bind(id, userId).first<Application>();
}

export async function updateApplication(
  db: D1Database,
  userId: string,
  id: string,
  patch: Partial<Omit<ApplicationInput, "url">> & { url?: string },
): Promise<Application | null> {
  const app = await getApplication(db, userId, id);
  if (!app) return null;
  const status = patch.status ?? app.status;
  await db
    .prepare(
      `UPDATE applications SET company = ?, role = ?, url = ?, status = ?, applied_at = ?, next_step = ?, next_step_date = ?, notes = ?, updated_at = ?
       WHERE id = ? AND user_id = ?`,
    )
    .bind(
      patch.company ?? app.company,
      patch.role ?? app.role,
      patch.url ?? app.url,
      status,
      app.applied_at ?? (status === "Applied" ? now() : null),
      patch.next_step !== undefined ? patch.next_step : app.next_step,
      patch.next_step_date !== undefined ? patch.next_step_date : app.next_step_date,
      patch.notes !== undefined ? patch.notes : app.notes,
      now(),
      id,
      userId,
    )
    .run();
  return getApplication(db, userId, id);
}

export async function listApplications(
  db: D1Database,
  userId: string,
  filter: { status?: Status; company?: string } = {},
): Promise<Application[]> {
  let sql = "SELECT * FROM applications WHERE user_id = ?";
  const args: unknown[] = [userId];
  if (filter.status) {
    sql += " AND status = ?";
    args.push(filter.status);
  }
  if (filter.company) {
    sql += " AND lower(company) LIKE lower(?)";
    args.push(`%${filter.company}%`);
  }
  sql += " ORDER BY updated_at DESC LIMIT 500";
  const { results } = await db.prepare(sql).bind(...args).all<Application>();
  return results;
}

export async function deleteApplication(db: D1Database, userId: string, id: string): Promise<boolean> {
  const r = await db.prepare("DELETE FROM applications WHERE id = ? AND user_id = ?").bind(id, userId).run();
  return r.meta.changes > 0;
}

const isoDate = (ms: number | null) => (ms ? new Date(ms).toISOString().slice(0, 10) : "");

export function applicationsToCsv(apps: Application[]): string {
  const header = ["Company", "Role", "Status", "Applied on", "Next step", "Next step date", "Notes", "URL", "Last updated"];
  const esc = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = apps.map((a) =>
    [a.company, a.role, a.status, isoDate(a.applied_at), a.next_step, a.next_step_date, a.notes, a.url, isoDate(a.updated_at)]
      .map(esc)
      .join(","),
  );
  return [header.join(","), ...rows].join("\n");
}

export async function listAnswers(db: D1Database, userId: string): Promise<SavedAnswer[]> {
  const { results } = await db
    .prepare("SELECT id, question, answer, source, updated_at FROM answers WHERE user_id = ? ORDER BY updated_at DESC LIMIT 500")
    .bind(userId)
    .all<SavedAnswer>();
  return results;
}

// Erase everything a user saved (profile, answers, tracker, extension sign-ins). The account row stays
// so the connector keeps working; signing in again starts empty.
export async function deleteUserData(db: D1Database, userId: string): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM profiles WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM answers WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM applications WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM ext_tokens WHERE user_id = ?").bind(userId),
  ]);
}
