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

// ---------- application tracker ----------
// Only company, role, URL, status and applied date, kept for 90 days after the last update.

export const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export const STATUSES = ["Interested", "Applying", "Applied", "OA", "Interview", "Offer", "Rejected", "Withdrawn"] as const;
export type Status = (typeof STATUSES)[number];

export interface Application {
  id: string;
  company: string;
  role: string;
  url: string | null;
  status: Status;
  applied_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface ApplicationInput {
  company: string;
  role: string;
  url?: string;
  status?: Status;
}

const fresh = () => now() - RETENTION_MS;

const urlKey = (url: string) => {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname.replace(/\/(apply|application)(\/.*)?$/, "").replace(/\/$/, "")}`;
  } catch {
    return url;
  }
};

async function findExisting(db: D1Database, userId: string, input: ApplicationInput): Promise<Application | null> {
  if (input.url) {
    const { results } = await db
      .prepare("SELECT * FROM applications WHERE user_id = ? AND url IS NOT NULL AND updated_at > ?")
      .bind(userId, fresh())
      .all<Application>();
    const key = urlKey(input.url);
    const hit = results.find((a) => a.url && urlKey(a.url) === key);
    if (hit) return hit;
  }
  return db
    .prepare("SELECT * FROM applications WHERE user_id = ? AND lower(company) = lower(?) AND lower(role) = lower(?) AND updated_at > ?")
    .bind(userId, input.company.trim(), input.role.trim(), fresh())
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
    await db
      .prepare("UPDATE applications SET url = ?, status = ?, applied_at = ?, updated_at = ? WHERE id = ?")
      .bind(input.url ?? existing.url, status, existing.applied_at ?? (status === "Applied" ? t : null), t, existing.id)
      .run();
    return { app: (await getApplication(db, userId, existing.id))!, created: false };
  }
  const id = newId();
  const status = input.status ?? "Interested";
  await db
    .prepare(
      `INSERT INTO applications (id, user_id, company, role, url, status, applied_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, userId, input.company.trim(), input.role.trim(), input.url ?? null, status, status === "Applied" ? t : null, t, t)
    .run();
  return { app: (await getApplication(db, userId, id))!, created: true };
}

export async function getApplication(db: D1Database, userId: string, id: string): Promise<Application | null> {
  return db
    .prepare("SELECT * FROM applications WHERE id = ? AND user_id = ? AND updated_at > ?")
    .bind(id, userId, fresh())
    .first<Application>();
}

export async function updateApplication(
  db: D1Database,
  userId: string,
  id: string,
  patch: Partial<ApplicationInput>,
): Promise<Application | null> {
  const app = await getApplication(db, userId, id);
  if (!app) return null;
  const status = patch.status ?? app.status;
  await db
    .prepare("UPDATE applications SET company = ?, role = ?, url = ?, status = ?, applied_at = ?, updated_at = ? WHERE id = ? AND user_id = ?")
    .bind(patch.company ?? app.company, patch.role ?? app.role, patch.url ?? app.url, status, app.applied_at ?? (status === "Applied" ? now() : null), now(), id, userId)
    .run();
  return getApplication(db, userId, id);
}

export async function listApplications(
  db: D1Database,
  userId: string,
  filter: { status?: Status; company?: string } = {},
): Promise<Application[]> {
  let sql = "SELECT * FROM applications WHERE user_id = ? AND updated_at > ?";
  const args: unknown[] = [userId, fresh()];
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
  const header = ["Company", "Role", "Status", "Applied on", "URL", "Last updated"];
  const esc = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = apps.map((a) => [a.company, a.role, a.status, isoDate(a.applied_at), a.url, isoDate(a.updated_at)].map(esc).join(","));
  return [header.join(","), ...rows].join("\n");
}

// Erase everything a user has with us except the account row (so the connector keeps working).
export async function deleteUserData(db: D1Database, userId: string): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM applications WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM ext_tokens WHERE user_id = ?").bind(userId),
  ]);
}

// Daily cleanup (Cron Trigger): applications past retention, expired extension sign-ins.
export async function purgeExpired(db: D1Database): Promise<{ applications: number; tokens: number }> {
  const [a, t] = await db.batch([
    db.prepare("DELETE FROM applications WHERE updated_at <= ?").bind(fresh()),
    db.prepare("DELETE FROM ext_tokens WHERE expires_at <= ?").bind(now()),
  ]);
  return { applications: a!.meta.changes, tokens: t!.meta.changes };
}
