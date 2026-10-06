// One radar tick (cron, every 30 minutes): poll the companies that are due, record new job ids, alert.
// Sized for the Workers Free plan: ≤ ~48 subrequests, a capped number of bytes parsed (CPU), and a
// handful of D1 statements per tick (rows go in as one JSON parameter instead of one statement each).

import { Budget, BudgetExhausted, pollBoard, type CompanyOpts, type Fetched, type RadarAts, type RadarJob } from "./adapters";
import { radarConfig } from "./config";
import { sendAlerts } from "./notify";
import { dedupeKey, scoreJob } from "./score";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
// How often each priority is polled; companies failing 3+ times in a row back off up to 32×.
export const PRIORITY_MINUTES: Record<number, number> = { 1: 30, 2: 60, 3: 120 };
const SEEN_CAP = 1500; // ids remembered for boards we only read part of (Workday, big SmartRecruiters)
const REPOST_WINDOW = 14 * DAY;

interface CompanyRow {
  id: number;
  name: string;
  ats: RadarAts;
  board: string;
  opts: string | null;
  seen_ids: string | null;
  etag: string | null;
  body_hash: string | null;
  last_polled_at: number | null;
  fail_count: number;
}

export interface TickSummary {
  at: number;
  ms: number;
  polled: number;
  unchanged: number;
  changed: number;
  baselined: number;
  new_jobs: number;
  reposts: number;
  failed: number;
  deferred: number;
  alerted: number;
  subrequests_left: number;
}

const intervalSql = `(CASE priority WHEN 1 THEN ${PRIORITY_MINUTES[1]! * MIN} WHEN 2 THEN ${PRIORITY_MINUTES[2]! * MIN} ELSE ${PRIORITY_MINUTES[3]! * MIN} END
  * (CASE WHEN fail_count >= 3 THEN (1 << MIN(fail_count - 2, 5)) ELSE 1 END))`;

async function dueCompanies(db: D1Database, now: number, limit: number): Promise<CompanyRow[]> {
  // A minute of slack so a 30-minute company isn't pushed to the next tick by cron jitter.
  const { results } = await db
    .prepare(
      `SELECT id, name, ats, board, opts, seen_ids, etag, body_hash, last_polled_at, fail_count FROM (
         SELECT *, ${intervalSql} AS iv FROM companies WHERE active = 1)
       WHERE last_polled_at IS NULL OR last_polled_at <= ?1 - iv + ?2
       ORDER BY last_polled_at IS NOT NULL, (?1 - last_polled_at) * 1.0 / iv DESC
       LIMIT ?3`,
    )
    .bind(now, MIN, limit)
    .all<CompanyRow>();
  return results;
}

// Run fn over items, at most `n` at a time (Workers allow 6 open connections).
async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]!);
      }
    }),
  );
  return out;
}

type PollResult = { row: CompanyRow; seen: Set<string> | null; opts: CompanyOpts } & ({ ok: true; f: Fetched } | { ok: false; error: unknown });

const parseJson = <T>(s: string | null, fallback: T): T => {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200);
const retryable = (e: unknown) => !(e instanceof BudgetExhausted) && !/^HTTP 4\d\d/.test(errText(e));

const sameSet = (a: string[], b: Set<string> | null) => !!b && a.length === b.size && a.every((x) => b.has(x));

export async function runRadar(env: Env, now = Date.now()): Promise<TickSummary> {
  const cfg = radarConfig(env);
  const db = env.DB;
  const started = Date.now();
  const budget = new Budget(cfg.subrequests - 1); // keep one for the alert
  const rows = await dueCompanies(db, now, cfg.batch);
  const sum: TickSummary = { at: now, ms: 0, polled: rows.length, unchanged: 0, changed: 0, baselined: 0, new_jobs: 0, reposts: 0, failed: 0, deferred: 0, alerted: 0, subrequests_left: 0 };

  if (rows.length) {
    // Claim the shard first, so a tick that dies half-way doesn't retry the same companies forever.
    await db.prepare("UPDATE companies SET last_polled_at = ? WHERE id IN (SELECT value FROM json_each(?))").bind(now, JSON.stringify(rows.map((r) => r.id))).run();
  }

  const results = await pool(rows, 6, async (row): Promise<PollResult> => {
    const seenList = parseJson<string[] | null>(row.seen_ids, null);
    const seen = seenList ? new Set(seenList) : null;
    const opts = parseJson<CompanyOpts>(row.opts, {});
    const target = { ats: row.ats, board: row.board, opts, etag: row.etag, bodyHash: row.body_hash, seen };
    try {
      return { row, seen, opts, ok: true, f: await pollBoard(budget, target) };
    } catch (e) {
      if (!retryable(e)) return { row, seen, opts, ok: false, error: e };
      try {
        return { row, seen, opts, ok: true, f: await pollBoard(budget, target) };
      } catch (e2) {
        return { row, seen, opts, ok: false, error: e2 };
      }
    }
  });

  const deferred: { id: number; at: number | null }[] = [];
  const failed: { id: number; error: string }[] = [];
  const recovered: number[] = [];
  const changedRows: { id: number; seen: string; etag: string | null; hash: string | null; opts: string; count: number }[] = [];
  const fresh: { row: CompanyRow; job: RadarJob }[] = [];

  // Parse changed boards, most overdue first, up to the CPU (bytes) budget; the rest wait a tick (and come first then).
  const changed = results.filter((r): r is PollResult & { ok: true; f: Extract<Fetched, { kind: "changed" }> } => r.ok && r.f.kind === "changed");
  let parsedBytes = 0;
  for (const r of results) {
    if (r.ok && r.f.kind === "unchanged") {
      sum.unchanged++;
      if (r.row.fail_count) recovered.push(r.row.id);
    } else if (!r.ok) {
      if (r.error instanceof BudgetExhausted) deferred.push({ id: r.row.id, at: r.row.last_polled_at });
      else failed.push({ id: r.row.id, error: errText(r.error) });
    }
  }
  for (const r of changed) {
    if (r.f.bytes > 0 && parsedBytes > 0 && parsedBytes + r.f.bytes > cfg.parseBytes) {
      deferred.push({ id: r.row.id, at: r.row.last_polled_at });
      continue;
    }
    parsedBytes += r.f.bytes;
    let jobs: RadarJob[];
    try {
      jobs = r.f.parse();
    } catch (e) {
      failed.push({ id: r.row.id, error: errText(e) });
      continue;
    }
    // An empty board that used to have jobs is more likely an outage or a format change than a hiring freeze.
    if (!jobs.length && r.seen?.size) {
      failed.push({ id: r.row.id, error: "board returned no jobs" });
      continue;
    }
    const ids = [...new Set(jobs.map((j) => j.extId))];
    const taken = new Set(r.seen ?? []);
    const newJobs = r.seen ? jobs.filter((j) => !taken.has(j.extId) && !!taken.add(j.extId)) : [];
    const keep = r.f.complete ? ids : [...new Set([...ids, ...(r.seen ?? [])])].slice(0, SEEN_CAP);
    const optsJson = JSON.stringify(r.f.opts);
    if (!newJobs.length && sameSet(keep, r.seen) && optsJson === JSON.stringify(r.opts)) {
      sum.unchanged++;
      if (r.row.fail_count) recovered.push(r.row.id);
      continue;
    }
    sum.changed++;
    changedRows.push({ id: r.row.id, seen: JSON.stringify(keep), etag: r.f.etag, hash: r.f.hash, opts: optsJson, count: jobs.length });
    if (!r.seen?.size) {
      sum.baselined++; // first poll (or a board that was empty): everything on it is "already there"
    } else if (newJobs.length > 30 && newJobs.length > jobs.length / 2) {
      // Most of a board "new" at once means its ids changed format, not a hiring spree.
      console.log(JSON.stringify({ evt: "radar_rebaseline", company: r.row.name, new: newJobs.length, total: jobs.length }));
      sum.baselined++;
    } else {
      for (const job of newJobs) fresh.push({ row: r.row, job });
    }
  }

  // Reposts: same company, title and place within 14 days.
  const inserts: object[] = [];
  if (fresh.length) {
    const companyIds = [...new Set(fresh.map((f) => f.row.id))];
    const { results: recent } = await db
      .prepare("SELECT company_id, dedupe_key FROM jobs WHERE company_id IN (SELECT value FROM json_each(?)) AND first_seen_at > ?")
      .bind(JSON.stringify(companyIds), now - REPOST_WINDOW)
      .all<{ company_id: number; dedupe_key: string }>();
    const known = new Set(recent.map((x) => `${x.company_id}|${x.dedupe_key}`));
    for (const { row, job } of fresh) {
      const key = dedupeKey(job.title, job.location);
      if (known.has(`${row.id}|${key}`)) {
        sum.reposts++;
        continue;
      }
      known.add(`${row.id}|${key}`);
      const s = scoreJob(job.title, job.location, job.remote);
      inserts.push({
        id: `${row.ats}:${row.board}:${job.extId}`,
        company_id: row.id,
        title: job.title.slice(0, 300),
        location: job.location.slice(0, 300),
        remote: job.remote ? 1 : 0,
        url: job.url,
        apply_url: job.applyUrl ?? null,
        posted_at: job.postedAt ?? null,
        score: s.score,
        reject: s.reject ?? null,
        dedupe_key: key,
      });
    }
    sum.new_jobs = inserts.length;
  }

  const writes: D1PreparedStatement[] = [];
  const each = (sql: string, items: unknown[], ...extra: unknown[]) => {
    if (items.length) writes.push(db.prepare(sql).bind(JSON.stringify(items), ...extra));
  };
  each(
    `INSERT OR IGNORE INTO jobs (id, company_id, title, location, remote, url, apply_url, posted_at, first_seen_at, score, reject, dedupe_key)
     SELECT value ->> '$.id', value ->> '$.company_id', value ->> '$.title', value ->> '$.location', value ->> '$.remote', value ->> '$.url',
            value ->> '$.apply_url', value ->> '$.posted_at', ?2, value ->> '$.score', value ->> '$.reject', value ->> '$.dedupe_key'
     FROM json_each(?1)`,
    inserts,
    now,
  );
  // Seen-id lists can be large; keep each statement's JSON well under D1's limits.
  for (let i = 0; i < changedRows.length; ) {
    const chunk: typeof changedRows = [];
    let size = 0;
    while (i < changedRows.length && (chunk.length === 0 || size + changedRows[i]!.seen.length < 500_000)) {
      size += changedRows[i]!.seen.length;
      chunk.push(changedRows[i++]!);
    }
    each(
      `UPDATE companies SET seen_ids = u.value ->> '$.seen', etag = u.value ->> '$.etag', body_hash = u.value ->> '$.hash', opts = u.value ->> '$.opts',
         job_count = u.value ->> '$.count', last_changed_at = ?2, last_error = NULL, fail_count = 0
       FROM json_each(?1) AS u WHERE companies.id = u.value ->> '$.id'`,
      chunk,
      now,
    );
  }
  each(
    `UPDATE companies SET last_error = u.value ->> '$.error', fail_count = fail_count + 1
     FROM json_each(?1) AS u WHERE companies.id = u.value ->> '$.id'`,
    failed,
  );
  each("UPDATE companies SET last_error = NULL, fail_count = 0 WHERE id IN (SELECT value FROM json_each(?1))", recovered);
  each(
    `UPDATE companies SET last_polled_at = u.value ->> '$.at'
     FROM json_each(?1) AS u WHERE companies.id = u.value ->> '$.id'`,
    deferred,
  );
  if (writes.length) await db.batch(writes);

  sum.failed = failed.length;
  sum.deferred = deferred.length;
  sum.alerted = await sendAlerts(env, cfg, now, new Budget(budget.remaining + 1)).catch((e) => {
    console.log(JSON.stringify({ evt: "radar_alert_error", error: errText(e) }));
    return 0;
  });
  sum.subrequests_left = budget.remaining;
  sum.ms = Date.now() - started;
  await db.prepare("INSERT INTO radar_state (key, value) VALUES ('last_tick', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(JSON.stringify(sum)).run();
  return sum;
}

// Daily cleanup: radar jobs and marks older than 30 days.
export async function purgeRadar(db: D1Database, now = Date.now()): Promise<{ jobs: number; marks: number }> {
  const [j, m] = await db.batch([
    db.prepare("DELETE FROM jobs WHERE first_seen_at < ?").bind(now - 30 * DAY),
    db.prepare("DELETE FROM job_marks WHERE updated_at < ? OR job_id NOT IN (SELECT id FROM jobs)").bind(now - 30 * DAY),
  ]);
  return { jobs: j!.meta.changes, marks: m!.meta.changes };
}
