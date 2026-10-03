// Find a company's job board and search it. Every board feeds the same last step: filter by
// keywords/location (where the board couldn't), drop old postings, sort newest first, then page.

import { detailsMore, discoverBoardUrl, discoverFromName, guessMore, parseMoreUrl, readJobPage, searchMore, type BoardPool, type MoreAts } from "./boards";
import { boardCandidates, filterJobs, findBoards, getJobDetails, oracleBoardFor, parseJobUrl, searchOracle, type JobDetails, type JobSummary } from "./jobs";

export interface SearchOptions {
  keywords?: string;
  location?: string;
  limit: number;
  offset: number;
  postedWithinDays: number; // 0 = no limit
}

const MORE: MoreAts[] = ["workday", "smartrecruiters", "workable", "recruitee"];
const DAY = 86_400_000;
const isUrl = (s: string) => /^https?:\/\//i.test(s.trim());

export const jobView = (j: JobSummary) => ({
  title: j.title,
  location: j.location,
  ...(j.department ? { team: j.department } : {}),
  ...(j.postedAt ? { posted: (j.postedApprox ? "before " : "") + String(j.postedAt).slice(0, 10) } : {}),
  url: j.url,
  ...(j.applyUrl && j.applyUrl !== j.url ? { apply_url: j.applyUrl } : {}),
  job_ref: `${j.ats}:${j.board}:${j.id}`,
});

const postedMs = (j: JobSummary) => {
  const t = j.postedAt ? Date.parse(j.postedAt) : NaN;
  return Number.isFinite(t) ? t : null;
};

// The shared filter → recency → sort → page step.
function finish(board: string, p: BoardPool, o: SearchOptions) {
  let jobs = p.pool;
  if (!p.keywordsApplied) jobs = filterJobs(jobs, o.keywords, undefined);
  if (o.location && !p.locationApplied) jobs = filterJobs(jobs, undefined, o.location);
  const cutoff = o.postedWithinDays > 0 ? Date.now() - o.postedWithinDays * DAY : null;
  let olderHidden = 0;
  if (cutoff) {
    jobs = jobs.filter((j) => {
      const t = postedMs(j);
      // "30+ days ago" only tells us it's at least that old
      const old = t !== null && (t < cutoff || (j.postedApprox && o.postedWithinDays <= 30));
      if (old) olderHidden++;
      return !old;
    });
  }
  jobs = [...jobs].sort((a, b) => (postedMs(b) ?? 0) - (postedMs(a) ?? 0));
  const page = jobs.slice(o.offset, o.offset + o.limit);
  const next = o.offset + o.limit < jobs.length ? o.offset + o.limit : undefined;
  const notes: string[] = [];
  if (p.partial) notes.push(`Large board: searched the first ${p.pool.length} of ${p.total} matches. Add keywords or a location to narrow it.`);
  if (!page.length && olderHidden) notes.push(`All ${olderHidden} matching jobs were posted more than ${o.postedWithinDays} days ago; call again with posted_within_days: 365 (or 0 for any date) if the user wants older ones.`);
  return {
    board,
    total_on_board: p.total,
    matching: jobs.length,
    returned: page.length,
    offset: o.offset,
    ...(next !== undefined ? { next_offset: next } : {}),
    ...(olderHidden ? { older_hidden: olderHidden, posted_within_days: o.postedWithinDays } : {}),
    ...(notes.length ? { note: notes.join(" ") } : {}),
    jobs: page.map(jobView),
  };
}

export async function searchCompany(company: string, o: SearchOptions, depth = 0): Promise<object | string> {
  const input = company.trim();

  // Oracle sorts by posting date and pages on its side.
  const oracle = oracleBoardFor(input);
  if (oracle) {
    const r = await searchOracle(oracle, o.keywords, o.location, o.limit, o.offset);
    if (!r) return "The company's Oracle careers site did not respond. Try again in a minute.";
    const cutoff = o.postedWithinDays > 0 ? Date.now() - o.postedWithinDays * DAY : null;
    const recent = cutoff ? r.jobs.filter((j) => (postedMs(j) ?? Date.now()) >= cutoff) : r.jobs;
    const hidden = r.jobs.length - recent.length;
    const next = o.offset + o.limit < r.total && !hidden ? o.offset + o.limit : undefined;
    return {
      board: `oracle:${oracle}`,
      matching: r.total,
      returned: recent.length,
      offset: o.offset,
      ...(next !== undefined ? { next_offset: next } : {}),
      ...(hidden ? { older_hidden: hidden, posted_within_days: o.postedWithinDays } : {}),
      ...(r.locationNote ? { note: r.locationNote } : {}),
      jobs: recent.map(jobView),
    };
  }

  const more = isUrl(input) ? parseMoreUrl(input) : null;
  if (more) {
    const r = await searchMore(more.ats, more.board, o.keywords, o.location);
    if (!r) return `The ${more.ats} board did not return jobs. Check the URL.`;
    return finish(`${more.ats}:${more.board}`, r, o);
  }

  if (isUrl(input) && !parseJobUrl(input)) {
    // An unknown careers page: find the board it uses, else read it as a single job posting.
    if (depth === 0) {
      const boardUrl = await discoverBoardUrl(input);
      if (boardUrl) return searchCompany(boardUrl, o, 1);
    }
    const page = await readJobPage(input);
    if (page && page.description.length > 300) {
      return { board: `page:${page.board}`, note: "This is a single job page, not a job board.", jobs: [{ ...jobView(page), job_ref: undefined }] };
    }
    return "Couldn't find a job board on that page. Ask the user for the link to a specific job, or search the web for the role; the extension can still fill the application on any site.";
  }

  const jobs = await findBoards(input);
  if (jobs) {
    return finish(`${jobs[0]!.ats}:${jobs[0]!.board}`, { total: jobs.length, pool: jobs, keywordsApplied: false, locationApplied: false, partial: false }, o);
  }
  if (!isUrl(input)) {
    const guess = await guessMore(boardCandidates(input), input, o.keywords);
    if (guess) return finish(`${guess.ats}:${guess.board}`, guess.r, o);
    if (depth === 0) {
      const found = await discoverFromName(input);
      if (found) return searchCompany(found, o, 1);
    }
  }
  return `No job board found for "${company}" from its name. Use web search to find ONE job posting or the job board of ${company} — e.g. search: ${company} careers (myworkdayjobs OR greenhouse OR lever OR ashbyhq OR smartrecruiters OR workable OR oraclecloud) — and call search_jobs again with that URL. Any single job URL on a job board is enough: the whole board is detected from it. If the company uses an unsupported system, get_job can still read any job page and the extension can fill the application.`;
}

export async function jobDetails(job: string): Promise<JobDetails | null> {
  const parts = job.split(":");
  if (!isUrl(job) && parts.length === 3) {
    const [ats, board, id] = parts as [string, string, string];
    if ((MORE as string[]).includes(ats)) return detailsMore(ats as MoreAts, board, id);
    if (["greenhouse", "lever", "ashby", "oracle"].includes(ats)) return getJobDetails(ats as "greenhouse", board, id);
  }
  if (!isUrl(job)) return null;
  const known = parseJobUrl(job);
  if (known?.id) return getJobDetails(known.ats, known.board, known.id);
  const more = parseMoreUrl(job);
  if (more?.id) {
    const d = await detailsMore(more.ats, more.board, more.id);
    if (d) return d;
  }
  return readJobPage(job);
}
