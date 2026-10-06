// Radar polling: read just the job ids, titles and locations of a board, as cheaply as possible.
// Unlike search (src/jobs.ts, src/boards.ts) nothing is cached, and the lightest endpoint is used per
// board, because the Free plan allows ~10 ms of CPU per cron run: Lever's JSON API and Ashby's posting API
// include full descriptions (6–14 MB on big boards), so we read Lever's HTML list and Ashby's GraphQL instead.
// Boards that send an ETag answer 304 when nothing changed; otherwise the body hash tells us.

import { workdayLocationFacet, workdayPostedAt, type WdFacetValue } from "../boards";
import { greenhouseApplyUrl, htmlToText } from "../jobs";

export type RadarAts = "greenhouse" | "lever" | "ashby" | "workday" | "oracle" | "smartrecruiters" | "workable" | "recruitee" | "bain";
export const RADAR_ATS: RadarAts[] = ["greenhouse", "lever", "ashby", "workday", "oracle", "smartrecruiters", "workable", "recruitee", "bain"];

export interface RadarJob {
  extId: string;
  title: string;
  location: string;
  remote: boolean;
  url: string;
  applyUrl?: string;
  postedAt?: string;
}

export interface CompanyOpts {
  location?: string; // Workday / Oracle: location facet to filter by (default "India")
  facets?: Record<string, string[]>; // Workday: resolved facet, cached after the first poll
  oracleLocation?: number | null; // Oracle: resolved location facet id (null = none found)
  country?: string; // SmartRecruiters: country code filter (default "in")
  leverHost?: string; // jobs.lever.co or jobs.eu.lever.co
}

export interface PollTarget {
  ats: RadarAts;
  board: string;
  opts: CompanyOpts;
  etag: string | null;
  bodyHash: string | null;
  seen: Set<string> | null;
}

// A fetched board, not parsed yet: parsing is the CPU-heavy part, so the poller decides when to parse.
export type Fetched =
  | { kind: "unchanged" }
  | { kind: "changed"; bytes: number; etag: string | null; hash: string | null; parse: () => RadarJob[]; complete: boolean; opts: CompanyOpts };

// Caps subrequests per cron run (Free plan: 50).
export class Budget {
  constructor(private left: number) {}
  take(): boolean {
    if (this.left <= 0) return false;
    this.left--;
    return true;
  }
  get remaining() {
    return this.left;
  }
}

export class BudgetExhausted extends Error {}

const UA = "JobSeeker-Radar/1.0 (+https://jobs.smudgee.xyz)";

async function get(budget: Budget, url: string, init: RequestInit & { etag?: string | null } = {}): Promise<Response> {
  if (!budget.take()) throw new BudgetExhausted();
  const headers: Record<string, string> = { "user-agent": UA, accept: "application/json, text/html;q=0.9", ...((init.headers as Record<string, string>) ?? {}) };
  if (init.etag) headers["if-none-match"] = init.etag;
  return fetch(url, { ...init, headers, cache: "no-store" });
}

async function sha1(buf: ArrayBuffer): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-1", buf));
  let s = "";
  for (const b of d) s += b.toString(16).padStart(2, "0");
  return s;
}

// Fetch a whole-board document: 304/same hash → unchanged, else hand back a lazy parser.
// `region` trims a page to the part that lists jobs (Lever pages carry a per-request nonce elsewhere).
async function fetchDoc(
  budget: Budget,
  t: PollTarget,
  url: string,
  init: RequestInit,
  parse: (body: string) => { jobs: RadarJob[]; complete?: boolean },
  opts: CompanyOpts = t.opts,
  region?: (body: string) => string,
): Promise<Fetched> {
  const res = await get(budget, url, { ...init, etag: t.etag });
  if (res.status === 304) return { kind: "unchanged" };
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  let buf = await res.arrayBuffer();
  let text: string | undefined;
  if (region) {
    text = region(new TextDecoder().decode(buf));
    buf = new TextEncoder().encode(text).buffer as ArrayBuffer;
  }
  const hash = await sha1(buf);
  if (hash === t.bodyHash && t.seen) return { kind: "unchanged" };
  let complete = true;
  return {
    kind: "changed",
    bytes: buf.byteLength,
    etag: res.headers.get("etag"),
    hash,
    opts,
    get complete() {
      return complete;
    },
    parse: () => {
      const r = parse(text ?? new TextDecoder().decode(buf));
      complete = r.complete ?? true;
      return r.jobs;
    },
  };
}

const isRemote = (s: string) => /remote|anywhere|work from home|wfh/i.test(s);

// ---------- per board ----------

function greenhouse(budget: Budget, t: PollTarget) {
  return fetchDoc(budget, t, `https://boards-api.greenhouse.io/v1/boards/${t.board}/jobs`, {}, (body) => ({
    jobs: (JSON.parse(body).jobs ?? []).map((j: any): RadarJob => {
      const location = j.location?.name ?? "";
      return {
        extId: String(j.id),
        title: j.title,
        location,
        remote: isRemote(location),
        url: j.absolute_url,
        applyUrl: greenhouseApplyUrl(t.board, String(j.id), j.absolute_url),
        postedAt: j.first_published ?? undefined,
      };
    }),
  }));
}

// jobs.lever.co/{board}: one <div class="posting" data-qa-posting-id="…"> per job, near the end of a ~700 KB page.
const POSTING = '<div class="posting" data-qa-posting-id="';
const leverRegion = (html: string) => {
  const start = html.indexOf(POSTING);
  if (start < 0) return "";
  const last = html.lastIndexOf(POSTING);
  const end = html.indexOf("</a></div>", last);
  return html.slice(start, end < 0 ? undefined : end + 10);
};

async function lever(budget: Budget, t: PollTarget): Promise<Fetched> {
  const parse = (host: string) => (body: string) => ({
    jobs: body
      .split(POSTING)
      .slice(1)
      .map((chunk): RadarJob | null => {
        const id = chunk.slice(0, chunk.indexOf('"'));
        const title = /data-qa="posting-name">([^<]*)</.exec(chunk)?.[1];
        if (!id || !title) return null;
        const location = htmlToText(/class="sort-by-location[^"]*">([^<]*)</.exec(chunk)?.[1] ?? "");
        const workplace = /workplaceTypes">([^<]*)</.exec(chunk)?.[1] ?? "";
        const url = `https://${host}/${t.board}/${id}`;
        return { extId: id, title: htmlToText(title), location, remote: isRemote(`${location} ${workplace}`), url, applyUrl: `${url}/apply` };
      })
      .filter((j): j is RadarJob => !!j),
  });
  const host = t.opts.leverHost ?? "jobs.lever.co";
  try {
    return await fetchDoc(budget, t, `https://${host}/${t.board}`, { headers: { accept: "text/html" } }, parse(host), t.opts, leverRegion);
  } catch (e) {
    if (t.opts.leverHost || !(e instanceof Error) || e.message !== "HTTP 404") throw e;
    const eu = "jobs.eu.lever.co";
    return fetchDoc(budget, t, `https://${eu}/${t.board}`, { headers: { accept: "text/html" } }, parse(eu), { ...t.opts, leverHost: eu }, leverRegion);
  }
}

const ASHBY_QUERY =
  "query ApiJobBoardWithTeams($organizationHostedJobsPageName: String!) { jobBoard: jobBoardWithTeams(organizationHostedJobsPageName: $organizationHostedJobsPageName) { jobPostings { id title locationName workplaceType secondaryLocations { locationName } } } }";

function ashby(budget: Budget, t: PollTarget) {
  const init = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ operationName: "ApiJobBoardWithTeams", variables: { organizationHostedJobsPageName: t.board }, query: ASHBY_QUERY }),
  };
  return fetchDoc(budget, t, "https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobBoardWithTeams", init, (body) => {
    const posts = JSON.parse(body)?.data?.jobBoard?.jobPostings;
    if (!Array.isArray(posts)) throw new Error("Ashby board not found");
    return {
      jobs: posts.map((j: any): RadarJob => {
        const location = [j.locationName, ...(j.secondaryLocations ?? []).map((l: any) => l.locationName)].filter(Boolean).join(", ");
        const url = `https://jobs.ashbyhq.com/${t.board}/${j.id}`;
        return { extId: j.id, title: j.title, location, remote: j.workplaceType === "Remote" || isRemote(location), url, applyUrl: `${url}/application` };
      }),
    };
  });
}

function smartrecruiters(budget: Budget, t: PollTarget) {
  const q = new URLSearchParams({ limit: "100" });
  const country = t.opts.country ?? "in";
  if (country) q.set("country", country);
  return fetchDoc(budget, t, `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(t.board)}/postings?${q}`, {}, (body) => {
    const d = JSON.parse(body);
    const content: any[] = d.content ?? [];
    return {
      complete: (d.totalFound ?? content.length) <= content.length,
      jobs: content.map((j): RadarJob => {
        const location = [j.location?.city, j.location?.region, j.location?.country?.toUpperCase()].filter(Boolean).join(", ");
        return { extId: j.id, title: j.name, location, remote: !!j.location?.remote, url: `https://jobs.smartrecruiters.com/${t.board}/${j.id}`, postedAt: j.releasedDate };
      }),
    };
  });
}

function workable(budget: Budget, t: PollTarget) {
  const init = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "", location: [], department: [], worktype: [], remote: [] }) };
  return fetchDoc(budget, t, `https://apply.workable.com/api/v3/accounts/${t.board}/jobs`, init, (body) => {
    const d = JSON.parse(body);
    const results: any[] = d.results ?? [];
    return {
      complete: !d.nextPage,
      jobs: results.map((j): RadarJob => {
        const location = j.location?.display ?? [j.location?.city, j.location?.country].filter(Boolean).join(", ");
        const url = `https://apply.workable.com/${t.board}/j/${j.shortcode}/`;
        return { extId: j.shortcode, title: j.title, location, remote: !!j.remote, url, applyUrl: `${url}apply/`, postedAt: j.published };
      }),
    };
  });
}

function recruitee(budget: Budget, t: PollTarget) {
  return fetchDoc(budget, t, `https://${t.board}.recruitee.com/api/offers/`, {}, (body) => ({
    jobs: (JSON.parse(body).offers ?? []).map((o: any): RadarJob => {
      const location = o.location ?? [o.city, o.country].filter(Boolean).join(", ");
      return { extId: String(o.id), title: o.title, location, remote: !!o.remote || isRemote(location), url: o.careers_url, applyUrl: o.careers_apply_url, postedAt: o.published_at };
    }),
  }));
}

// Workday lists newest first when there's no search text. Read pages of 20 until one has a job we've seen.
const WD_MAX_PAGES = 3;

async function workday(budget: Budget, t: PollTarget): Promise<Fetched> {
  const [host, tenant, site] = t.board.split("/");
  const api = `https://${host}/wday/cxs/${tenant}/${site}/jobs`;
  const page = async (facets: Record<string, string[]>, offset: number) => {
    const res = await get(budget, api, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ appliedFacets: facets, limit: 20, offset, searchText: "" }) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as { total?: number; jobPostings?: any[]; facets?: WdFacetValue[] };
  };
  let opts = t.opts;
  let first = await page(opts.facets ?? {}, 0);
  if (!opts.facets) {
    // First poll: find the location facet once and remember it.
    const facet = workdayLocationFacet(first.facets ?? [], opts.location ?? "India");
    opts = { ...opts, facets: facet ? { [facet.param]: [facet.id] } : {} };
    if (facet) first = await page(opts.facets!, 0);
  }
  const posts = [...(first.jobPostings ?? [])];
  const total = first.total ?? posts.length;
  const unseen = (list: any[]) => !!t.seen && list.length > 0 && list.every((j) => !t.seen!.has(j.externalPath));
  for (let p = 1; p < WD_MAX_PAGES && posts.length < total && unseen(posts.slice(-20)) && budget.remaining > 2; p++) {
    posts.push(...((await page(opts.facets!, p * 20)).jobPostings ?? []));
  }
  const jobs = posts.map((j): RadarJob => {
    const url = `https://${host}/${site}${j.externalPath}`;
    // "3 Locations": on a location-filtered board they're all in that place.
    let location: string = j.locationsText ?? "";
    if (/^\d+ Locations?$/i.test(location) && Object.keys(opts.facets ?? {}).length) location += ` (${opts.location ?? "India"})`;
    return { extId: j.externalPath, title: j.title, location, remote: isRemote(`${location} ${j.remoteType ?? ""}`), url, applyUrl: `${url}/apply`, postedAt: workdayPostedAt(j.postedOn).at };
  });
  // bytes 0: Workday pages are small and already parsed, so they never wait for the parse budget.
  return { kind: "changed", bytes: 0, etag: null, hash: null, parse: () => jobs, complete: posts.length >= total, opts };
}

// Oracle Recruiting Cloud (JPMorgan, BNY, Amex): sorted newest first on Oracle's side, filtered to a location.
const ORACLE_PAGE = 25;

async function oracle(budget: Budget, t: PollTarget): Promise<Fetched> {
  const [host, site] = t.board.split("/");
  const query = async (finder: Record<string, string | number>, expand: string) => {
    const f = Object.entries({ siteNumber: site!, ...finder })
      .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
      .join(",");
    const res = await get(budget, `https://${host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&expand=${expand}&finder=findReqs;${f}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const item = ((await res.json()) as any)?.items?.[0];
    if (!item) throw new Error("Oracle board not found");
    return item;
  };
  let opts = t.opts;
  if (opts.oracleLocation === undefined) {
    // First poll: find the location facet once and remember it.
    const want = (opts.location ?? "India").toLowerCase();
    const facets: { Id: number; Name: string }[] = (await query({ limit: 1, facetsList: "LOCATIONS" }, "locationsFacet")).locationsFacet ?? [];
    const hit = facets.find((l) => l.Name.trim().toLowerCase() === want) ?? facets.find((l) => l.Name.toLowerCase().startsWith(want + ","));
    opts = { ...opts, oracleLocation: hit?.Id ?? null };
  }
  const page = (offset: number) =>
    query(
      { limit: ORACLE_PAGE, offset, sortBy: "POSTING_DATES_DESC", ...(opts.oracleLocation ? { selectedLocationsFacet: opts.oracleLocation } : {}) },
      "requisitionList.secondaryLocations",
    );
  const first = await page(0);
  const reqs: any[] = [...(first.requisitionList ?? [])];
  const total: number = first.TotalJobsCount ?? reqs.length;
  const unseen = (list: any[]) => !!t.seen && list.length > 0 && list.every((r) => !t.seen!.has(String(r.Id)));
  for (let p = 1; p < 3 && reqs.length < total && unseen(reqs.slice(-ORACLE_PAGE)) && budget.remaining > 2; p++) {
    reqs.push(...((await page(p * ORACLE_PAGE)).requisitionList ?? []));
  }
  const jobs = reqs.map((r): RadarJob => {
    const location = [r.PrimaryLocation, ...(r.secondaryLocations ?? []).map((l: any) => l.Name)].filter(Boolean).join("; ");
    const url = `https://${host}/hcmUI/CandidateExperience/en/sites/${site}/job/${r.Id}`;
    return { extId: String(r.Id), title: r.Title, location, remote: isRemote(`${location} ${r.WorkplaceType ?? ""}`), url, applyUrl: url, postedAt: r.PostedDate };
  });
  return { kind: "changed", bytes: 0, etag: null, hash: null, parse: () => jobs, complete: reqs.length >= total, opts };
}

// Bain's own careers API (2 MB with full descriptions, no location filter): pick out only id, title and offices.
function bain(budget: Budget, t: PollTarget) {
  const region = (body: string) => {
    const heads = [...body.matchAll(/"JobId":"(\d+)","JobTitle":("(?:[^"\\]|\\.)*")/g)];
    // "Location":["New Delhi ", " Mumbai "]
    const locs = [...body.matchAll(/"Location":(\[(?:"(?:[^"\\]|\\.)*",?\s*)*\])/g)];
    if (!heads.length || heads.length !== locs.length) throw new Error("Bain response format changed");
    const total = Number(/"totalResults":(\d+)/.exec(body)?.[1] ?? heads.length);
    const offices = (json: string) => (JSON.parse(json) as string[]).map((x) => x.trim()).filter(Boolean).join(", ");
    return JSON.stringify({ total, jobs: heads.map((m, i) => [m[1], JSON.parse(m[2]!) as string, offices(locs[i]![1]!)]) });
  };
  const init = { headers: { referer: "https://www.bain.com/careers/find-a-role/", "x-requested-with": "XMLHttpRequest", "user-agent": "Mozilla/5.0 (compatible; JobSeeker-Radar/1.0)" } };
  return fetchDoc(
    budget,
    t,
    "https://www.bain.com/en/api/jobsearch/keyword/get?keyword=&start=0&results=500",
    init,
    (body) => {
      const d = JSON.parse(body) as { total: number; jobs: [string, string, string][] };
      return {
        complete: d.jobs.length >= d.total,
        jobs: d.jobs.map(([id, title, location]): RadarJob => {
          const url = `https://www.bain.com/careers/find-a-role/position/?jobid=${id}`;
          return { extId: id, title, location, remote: isRemote(location), url, applyUrl: url };
        }),
      };
    },
    t.opts,
    region,
  );
}

export function pollBoard(budget: Budget, t: PollTarget): Promise<Fetched> {
  switch (t.ats) {
    case "greenhouse":
      return greenhouse(budget, t);
    case "lever":
      return lever(budget, t);
    case "ashby":
      return ashby(budget, t);
    case "workday":
      return workday(budget, t);
    case "oracle":
      return oracle(budget, t);
    case "bain":
      return bain(budget, t);
    case "smartrecruiters":
      return smartrecruiters(budget, t);
    case "workable":
      return workable(budget, t);
    case "recruitee":
      return recruitee(budget, t);
  }
}
