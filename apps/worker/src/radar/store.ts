// Radar reads/writes for the MCP tools: new jobs, per-user marks, the watchlist, health.

import { discoverBoardUrl, discoverFromName, guessMore, parseMoreUrl } from "../boards";
import { boardCandidates, findBoards, parseJobUrl } from "../jobs";
import { Budget, RADAR_ATS, pollBoard, type RadarAts } from "./adapters";
import { radarConfig } from "./config";
import { ago, isQuiet } from "./notify";
import { PRIORITY_MINUTES, type TickSummary } from "./poller";

const HOUR = 3_600_000;

export const MARKS = ["digested", "dismissed", "applied"] as const;
export type Mark = (typeof MARKS)[number];

export interface NewJobsFilter {
  sinceHours: number;
  minScore: number;
  status: "new" | "all" | Mark;
  company?: string;
  limit: number;
}

export async function getNewJobs(db: D1Database, userId: string, f: NewJobsFilter, now = Date.now()) {
  let sql = `SELECT j.id, j.title, j.location, j.remote, j.url, j.apply_url, j.posted_at, j.first_seen_at, j.score, j.notified_at,
               c.name AS company, m.status AS mark
             FROM jobs j JOIN companies c ON c.id = j.company_id
             LEFT JOIN job_marks m ON m.job_id = j.id AND m.user_id = ?
             WHERE j.first_seen_at > ? AND j.score >= ?`;
  const args: unknown[] = [userId, now - f.sinceHours * HOUR, f.minScore];
  if (f.status === "new") sql += " AND m.status IS NULL";
  else if (f.status !== "all") {
    sql += " AND m.status = ?";
    args.push(f.status);
  }
  if (f.company) {
    sql += " AND lower(c.name) LIKE lower(?)";
    args.push(`%${f.company}%`);
  }
  sql += " ORDER BY j.score DESC, j.first_seen_at DESC LIMIT ?";
  args.push(f.limit + 1);
  const { results } = await db.prepare(sql).bind(...args).all<any>();
  return {
    more: results.length > f.limit,
    jobs: results.slice(0, f.limit).map((j) => ({
      job_ref: j.id,
      title: j.title,
      company: j.company,
      location: j.location,
      ...(j.remote ? { remote: true } : {}),
      score: j.score,
      first_seen: `${new Date(j.first_seen_at).toISOString().slice(0, 16)}Z (${ago(now - j.first_seen_at)})`,
      ...(j.posted_at ? { posted: String(j.posted_at).slice(0, 10) } : {}),
      url: j.url,
      ...(j.apply_url && j.apply_url !== j.url ? { apply_url: j.apply_url } : {}),
      ...(j.notified_at ? { alerted: true } : {}),
      ...(j.mark ? { status: j.mark } : {}),
    })),
  };
}

export async function markJobs(db: D1Database, userId: string, ids: string[], status: Mark, now = Date.now()): Promise<number> {
  const r = await db
    .prepare(
      `INSERT INTO job_marks (user_id, job_id, status, updated_at)
       SELECT ?1, value, ?2, ?3 FROM json_each(?4) WHERE value IN (SELECT id FROM jobs)
       ON CONFLICT (user_id, job_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`,
    )
    .bind(userId, status, now, JSON.stringify(ids))
    .run();
  return r.meta.changes;
}

export async function listWatchlist(db: D1Database, f: { query?: string; ats?: string; includeInactive: boolean }) {
  let sql = "SELECT id, name, ats, board, priority, active, job_count, last_polled_at, fail_count, last_error FROM companies WHERE 1 = 1";
  const args: unknown[] = [];
  if (!f.includeInactive) sql += " AND active = 1";
  if (f.ats) {
    sql += " AND ats = ?";
    args.push(f.ats);
  }
  if (f.query) {
    sql += " AND (lower(name) LIKE lower(?) OR lower(board) LIKE lower(?))";
    args.push(`%${f.query}%`, `%${f.query}%`);
  }
  sql += " ORDER BY priority, name LIMIT 500";
  const { results } = await db.prepare(sql).bind(...args).all<any>();
  return results;
}

// A company name or careers/job URL → the board the radar polls.
export async function resolveBoard(input: string): Promise<{ ats: RadarAts; board: string } | string> {
  if (/^https?:\/\/(www\.)?bain\.com\//i.test(input) || /^bain( (&|and) (co|company))?\.?$/i.test(input.trim())) return { ats: "bain", board: "bain" };
  const fromUrl = (u: string) => {
    const a = parseJobUrl(u);
    if (a && (RADAR_ATS as string[]).includes(a.ats)) return { ats: a.ats as RadarAts, board: a.board };
    const b = parseMoreUrl(u);
    if (b) return { ats: b.ats as RadarAts, board: b.board };
    return null;
  };
  const isUrl = /^https?:\/\//i.test(input);
  let hit = isUrl ? fromUrl(input) : null;
  if (!hit && isUrl) {
    const found = await discoverBoardUrl(input);
    if (found) hit = fromUrl(found);
  }
  if (!hit && !isUrl) {
    const jobs = await findBoards(input);
    if (jobs?.[0]) return { ats: jobs[0].ats as RadarAts, board: jobs[0].board };
    const guess = await guessMore(boardCandidates(input), input);
    if (guess) return { ats: guess.ats, board: guess.board };
    const found = await discoverFromName(input);
    if (found) hit = fromUrl(found);
  }
  if (!hit) return `No supported job board found for "${input}". Web-search for one of its job postings (greenhouse, lever, ashbyhq, myworkdayjobs, smartrecruiters, workable, recruitee) and call watchlist_add with that URL.`;
  return hit;
}

export async function addCompany(db: D1Database, name: string, ats: RadarAts, board: string, priority: number, opts: Record<string, string>) {
  // Check the board answers before adding it (the first poll then records what's already there).
  const f = await pollBoard(new Budget(4), { ats, board, opts, etag: null, bodyHash: null, seen: null });
  const jobs = f.kind === "changed" ? f.parse().length : 0;
  const row = await db
    .prepare(
      `INSERT INTO companies (name, ats, board, priority, opts, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (ats, board) DO UPDATE SET name = excluded.name, priority = excluded.priority, active = 1,
         opts = CASE WHEN excluded.opts = '{}' THEN companies.opts ELSE excluded.opts END
       RETURNING id, name, ats, board, priority, (seen_ids IS NOT NULL) AS polled_before`,
    )
    .bind(name, ats, board, priority, JSON.stringify(opts), Date.now())
    .first<any>();
  return { ...row, jobs_on_board: jobs };
}

export async function setCompanyActive(db: D1Database, id: number, active: boolean): Promise<any | null> {
  return db.prepare("UPDATE companies SET active = ? WHERE id = ? RETURNING id, name, ats, board, active").bind(active ? 1 : 0, id).first();
}

export async function radarHealth(env: Env, now = Date.now()) {
  const db = env.DB;
  const cfg = radarConfig(env);
  const [counts, failing, tick, found] = await db.batch([
    db.prepare(
      `SELECT count(*) AS active, sum(last_polled_at > ?1) AS polled_last_hour, sum(seen_ids IS NULL) AS never_polled,
         sum(fail_count >= 3) AS failing, min(last_polled_at) AS oldest_poll FROM companies WHERE active = 1`,
    ).bind(now - HOUR),
    db.prepare("SELECT id, name, ats, board, fail_count, last_error FROM companies WHERE active = 1 AND fail_count > 0 ORDER BY fail_count DESC LIMIT 15"),
    db.prepare("SELECT value FROM radar_state WHERE key = 'last_tick'"),
    db.prepare(
      `SELECT count(*) AS new_jobs, sum(score >= ?2) AS strong, sum(notified_at IS NOT NULL) AS alerted, sum(score > 0) AS kept
       FROM jobs WHERE first_seen_at > ?1`,
    ).bind(now - 24 * HOUR, cfg.alertMin),
  ]);
  const c = (counts!.results[0] ?? {}) as any;
  const last = tick!.results[0] ? (JSON.parse((tick!.results[0] as any).value) as TickSummary) : null;
  const f = (found!.results[0] ?? {}) as any;
  return {
    companies: {
      active: c.active ?? 0,
      polled_last_hour: c.polled_last_hour ?? 0,
      waiting_for_first_poll: c.never_polled ?? 0,
      failing_3_plus: c.failing ?? 0,
      ...(c.oldest_poll ? { stalest_poll: ago(now - c.oldest_poll) } : {}),
      poll_every_minutes_by_priority: PRIORITY_MINUTES,
    },
    last_24h: { new_jobs: f.new_jobs ?? 0, matches: f.kept ?? 0, strong: f.strong ?? 0, alerted: f.alerted ?? 0 },
    last_tick: last ? { ...last, at: `${new Date(last.at).toISOString()} (${ago(now - last.at)})` } : "never ran",
    alerts: {
      telegram: !!(cfg.telegramToken && cfg.telegramChat),
      min_score: cfg.alertMin,
      quiet_hours: `${cfg.quietStart}:00–${cfg.quietEnd}:00 ${cfg.timeZone}`,
      quiet_now: isQuiet(cfg, now),
    },
    ...(failing!.results.length ? { errors: failing!.results } : {}),
  };
}
