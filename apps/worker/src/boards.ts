// More job boards (Workday, SmartRecruiters, Workable, Recruitee), a generic job-page reader
// (schema.org JobPosting), and detection of which board a company's careers page uses.

import { htmlToText, type JobDetails, type JobSummary } from "./jobs";

export type MoreAts = "workday" | "smartrecruiters" | "workable" | "recruitee";

// What a board search hands to the shared filter/sort/page step in search.ts.
export interface BoardPool {
  total: number; // jobs on the board matching what the board itself filtered
  pool: JobSummary[]; // the jobs we actually read
  keywordsApplied: boolean; // the board already filtered by keywords
  locationApplied: boolean; // the board already filtered by location
  partial: boolean; // the board has more matching jobs than we read
}

// Workday only says "Posted Today", "Posted Yesterday", "Posted 3 Days Ago", "Posted 30+ Days Ago".
export function workdayPostedAt(text: string | undefined): { at?: string; approx?: boolean } {
  if (!text) return {};
  const day = 86_400_000;
  const t = text.toLowerCase();
  if (t.includes("today")) return { at: new Date().toISOString() };
  if (t.includes("yesterday")) return { at: new Date(Date.now() - day).toISOString() };
  const m = /(\d+)(\+)?\s*days?/.exec(t);
  if (m) return { at: new Date(Date.now() - Number(m[1]) * day).toISOString(), approx: !!m[2] };
  return {};
}

const UA = { "user-agent": "Mozilla/5.0 (compatible; JobSeeker/1.0; +https://jobs.smudgee.xyz)" };

async function json(url: string, init?: RequestInit): Promise<any | null> {
  try {
    const res = await fetch(url, {
      ...init,
      headers: { accept: "application/json", ...UA, ...(init?.headers ?? {}) },
      cf: { cacheTtl: 1800, cacheEverything: init?.method !== "POST" },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

const post = (url: string, body: unknown) =>
  json(url, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

// ---------- Workday ----------
// Board: "<host>/<tenant>/<site>", e.g. "nvidia.wd5.myworkdayjobs.com/nvidia/NVIDIAExternalCareerSite". Job id: externalPath.


const wdParts = (board: string) => {
  const [host, tenant, site] = board.split("/");
  return { host: host!, tenant: tenant!, site: site! };
};
const wdJobUrl = (board: string, path: string) => {
  const { host, site } = wdParts(board);
  return `https://${host}/${site}${path}`;
};

export function parseWorkdayUrl(u: URL): { board: string; id?: string } | null {
  if (!/\.myworkday(jobs|site)\.com$/.test(u.hostname)) return null;
  const parts = u.pathname.split("/").filter(Boolean);
  if (parts[0] && /^[a-z]{2}-[A-Z]{2}$/.test(parts[0])) parts.shift(); // locale
  const site = parts[0];
  if (!site) return null;
  const tenant = u.hostname.split(".")[0]!;
  const jobIdx = parts.indexOf("job");
  const id = jobIdx >= 0 ? "/" + parts.slice(jobIdx).filter((p) => p !== "apply").join("/") : undefined;
  return { board: `${u.hostname}/${tenant}/${site}`, id };
}

interface WdFacetValue {
  descriptor?: string;
  id?: string;
  count?: number;
  facetParameter?: string;
  values?: WdFacetValue[];
}

// Location facets are nested (e.g. locationMainGroup → locations / locationHierarchy1).
function workdayLocationFacet(facets: WdFacetValue[], location: string): { param: string; id: string } | null {
  const want = location.toLowerCase().replace(/^bangalore\b/, "bengaluru").trim();
  const leaves: { param: string; id: string; name: string; specific: boolean }[] = [];
  const walk = (list: WdFacetValue[] | undefined, param: string | undefined) => {
    for (const v of list ?? []) {
      if (v.values) walk(v.values, v.facetParameter ?? param);
      else if (v.id && v.descriptor && param && /location/i.test(param)) leaves.push({ param, id: v.id, name: v.descriptor.toLowerCase(), specific: param === "locations" });
    }
  };
  walk(facets, undefined);
  const words = (n: string) => n.split(/[,\s]+/).filter(Boolean);
  const hit =
    leaves.find((l) => l.name === want) ??
    leaves.find((l) => l.specific && words(l.name).includes(want)) ??
    leaves.find((l) => words(l.name).includes(want)) ??
    leaves.find((l) => l.name.includes(want));
  return hit ? { param: hit.param, id: hit.id } : null;
}

const WD_PAGES = 5; // 5 × 20 = 100 jobs read per search (Workday's page size is 20)

async function workdaySearch(board: string, keywords?: string, location?: string): Promise<BoardPool | null> {
  const { host, tenant, site } = wdParts(board);
  const api = `https://${host}/wday/cxs/${tenant}/${site}/jobs`;
  const searchText = keywords ?? "";
  const first = await post(api, { appliedFacets: {}, limit: 20, offset: 0, searchText });
  if (!first?.jobPostings) return null;
  let applied: Record<string, string[]> = {};
  let locationApplied = false;
  if (location) {
    const facet = workdayLocationFacet(first.facets ?? [], location);
    if (facet) {
      applied = { [facet.param]: [facet.id] };
      locationApplied = true;
    }
  }
  const firstPage = locationApplied ? await post(api, { appliedFacets: applied, limit: 20, offset: 0, searchText }) : first;
  const total: number = firstPage?.total ?? 0;
  const rest = await Promise.all(
    Array.from({ length: Math.min(WD_PAGES, Math.ceil(total / 20)) - 1 }, (_, i) =>
      post(api, { appliedFacets: applied, limit: 20, offset: (i + 1) * 20, searchText }),
    ),
  );
  const pool: JobSummary[] = [firstPage, ...rest]
    .flatMap((p) => p?.jobPostings ?? [])
    .map((j: any) => {
      const posted = workdayPostedAt(j.postedOn);
      return {
        ats: "workday" as const,
        board,
        id: j.externalPath,
        title: j.title,
        location: j.locationsText ?? "",
        url: wdJobUrl(board, j.externalPath),
        applyUrl: `${wdJobUrl(board, j.externalPath)}/apply`,
        postedAt: posted.at,
        postedApprox: posted.approx,
      };
    });
  return { total, pool, keywordsApplied: true, locationApplied, partial: total > pool.length };
}

async function workdayDetails(board: string, path: string): Promise<JobDetails | null> {
  const { host, tenant, site } = wdParts(board);
  const d = await json(`https://${host}/wday/cxs/${tenant}/${site}${path}`);
  const j = d?.jobPostingInfo;
  if (!j) return null;
  const url = j.externalUrl ?? wdJobUrl(board, path);
  return {
    ats: "workday",
    board,
    id: path,
    title: j.title,
    location: [j.location, ...(j.additionalLocations ?? [])].filter(Boolean).join("; "),
    url,
    applyUrl: `${url}/apply`,
    updatedAt: j.startDate,
    description: htmlToText(j.jobDescription ?? ""),
  };
}

// ---------- SmartRecruiters ----------

async function srSearch(company: string, keywords?: string): Promise<BoardPool | null> {
  const q = new URLSearchParams({ limit: "100" });
  if (keywords) q.set("q", keywords);
  const base = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(company)}/postings?${q}`;
  const first = await json(base);
  if (!first?.content?.length) return null;
  const total: number = first.totalFound ?? first.content.length;
  const more = total > 100 ? await Promise.all([100, 200].filter((o) => o < total).map((o) => json(`${base}&offset=${o}`))) : [];
  const pool: JobSummary[] = [first, ...more]
    .flatMap((d) => d?.content ?? [])
    .map((j: any) => ({
      ats: "smartrecruiters" as const,
      board: company,
      id: j.id,
      title: j.name,
      location: [j.location?.city, j.location?.region, j.location?.country?.toUpperCase()].filter(Boolean).join(", ") + (j.location?.remote ? " (Remote)" : ""),
      department: j.department?.label,
      url: `https://jobs.smartrecruiters.com/${company}/${j.id}`,
      postedAt: j.releasedDate,
    }));
  return { total, pool, keywordsApplied: true, locationApplied: false, partial: total > pool.length };
}

async function srDetails(company: string, id: string): Promise<JobDetails | null> {
  const j = await json(`https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(company)}/postings/${encodeURIComponent(id)}`);
  if (!j?.id) return null;
  const s = j.jobAd?.sections ?? {};
  const description = ["jobDescription", "qualifications", "additionalInformation", "companyDescription"]
    .map((k) => (s[k]?.text ? `${s[k].title ?? ""}\n${htmlToText(s[k].text)}` : ""))
    .filter(Boolean)
    .join("\n\n");
  return {
    ats: "smartrecruiters",
    board: company,
    id: j.id,
    title: j.name,
    location: j.location?.fullLocation ?? [j.location?.city, j.location?.country].filter(Boolean).join(", "),
    url: j.postingUrl,
    applyUrl: j.applyUrl ?? j.postingUrl,
    updatedAt: j.releasedDate,
    description,
  };
}

// ---------- Workable ----------

async function workableSearch(account: string, keywords?: string): Promise<BoardPool | null> {
  const d = await post(`https://apply.workable.com/api/v3/accounts/${account}/jobs`, { query: keywords ?? "", location: [], department: [], worktype: [], remote: [] });
  if (!d?.results?.length) return null;
  const pool: JobSummary[] = d.results.map((j: any) => ({
    ats: "workable" as const,
    board: account,
    id: j.shortcode,
    title: j.title,
    location: (j.location?.display ?? [j.location?.city, j.location?.country].filter(Boolean).join(", ")) + (j.remote ? " (Remote)" : ""),
    department: Array.isArray(j.department) ? j.department[0] : j.department,
    url: `https://apply.workable.com/${account}/j/${j.shortcode}/`,
    applyUrl: `https://apply.workable.com/${account}/j/${j.shortcode}/apply/`,
    postedAt: j.published,
  }));
  const total: number = d.total ?? pool.length;
  return { total, pool, keywordsApplied: true, locationApplied: false, partial: total > pool.length };
}

async function workableDetails(account: string, code: string): Promise<JobDetails | null> {
  const j = await json(`https://apply.workable.com/api/v2/accounts/${account}/jobs/${code}`);
  if (!j?.shortcode) return null;
  const url = `https://apply.workable.com/${account}/j/${code}/`;
  return {
    ats: "workable",
    board: account,
    id: code,
    title: j.title,
    location: j.location?.city ? `${j.location.city}, ${j.location.country}` : (j.location?.country ?? ""),
    url,
    applyUrl: `${url}apply/`,
    updatedAt: j.published,
    description: htmlToText([j.description, j.requirements && `<h3>Requirements</h3>${j.requirements}`, j.benefits && `<h3>Benefits</h3>${j.benefits}`].filter(Boolean).join("")),
  };
}

// ---------- Recruitee ----------

async function recruiteeOffers(slug: string): Promise<any[] | null> {
  const d = await json(`https://${slug}.recruitee.com/api/offers/`);
  return d?.offers?.length ? d.offers : null;
}

function recruiteeSummary(slug: string, o: any): JobSummary {
  return {
    ats: "recruitee",
    board: slug,
    id: String(o.id),
    title: o.title,
    location: o.location ?? [o.city, o.country].filter(Boolean).join(", "),
    department: o.department,
    url: o.careers_url,
    applyUrl: o.careers_apply_url,
    postedAt: o.published_at ?? o.created_at,
  };
}

async function recruiteeSearch(slug: string): Promise<BoardPool | null> {
  const offers = await recruiteeOffers(slug);
  if (!offers) return null;
  return { total: offers.length, pool: offers.map((o) => recruiteeSummary(slug, o)), keywordsApplied: false, locationApplied: false, partial: false };
}

async function recruiteeDetails(slug: string, id: string): Promise<JobDetails | null> {
  const o = (await recruiteeOffers(slug))?.find((x) => String(x.id) === id);
  if (!o) return null;
  return {
    ...recruiteeSummary(slug, o),
    applyUrl: o.careers_apply_url,
    description: htmlToText(`${o.description ?? ""}<h3>Requirements</h3>${o.requirements ?? ""}`),
  };
}

// ---------- dispatch ----------

export async function searchMore(ats: MoreAts, board: string, keywords?: string, location?: string): Promise<BoardPool | null> {
  switch (ats) {
    case "workday":
      return workdaySearch(board, keywords, location);
    case "smartrecruiters":
      return srSearch(board, keywords);
    case "workable":
      return workableSearch(board, keywords);
    case "recruitee":
      return recruiteeSearch(board);
  }
}

export async function detailsMore(ats: MoreAts, board: string, id: string): Promise<JobDetails | null> {
  switch (ats) {
    case "workday":
      return workdayDetails(board, id);
    case "smartrecruiters":
      return srDetails(board, id);
    case "workable":
      return workableDetails(board, id);
    case "recruitee":
      return recruiteeDetails(board, id);
  }
}

export function parseMoreUrl(raw: string): { ats: MoreAts; board: string; id?: string } | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const wd = parseWorkdayUrl(u);
  if (wd) return { ats: "workday", ...wd };
  const parts = u.pathname.split("/").filter(Boolean);
  if (/(^|\.)smartrecruiters\.com$/.test(u.hostname) && parts[0] && parts[0] !== "api") {
    const id = parts[1]?.match(/^(\d+)/)?.[1];
    return { ats: "smartrecruiters", board: parts[0], id };
  }
  if (u.hostname === "apply.workable.com" && parts[0]) {
    return { ats: "workable", board: parts[0], id: parts[1] === "j" ? parts[2] : undefined };
  }
  if (u.hostname.endsWith(".recruitee.com")) {
    return { ats: "recruitee", board: u.hostname.split(".")[0]! };
  }
  return null;
}

// Try the boards that don't need an exact URL, guessing the company's slug.
export async function guessMore(slugs: string[], original: string, keywords?: string): Promise<{ ats: MoreAts; board: string; r: BoardPool } | null> {
  const srIds = [...new Set([original.replace(/[^A-Za-z0-9]/g, ""), ...slugs])];
  type Attempt = { ats: MoreAts; board: string; r: BoardPool | null };
  const attempts: Promise<Attempt>[] = [
    ...srIds.slice(0, 2).map(async (b): Promise<Attempt> => ({ ats: "smartrecruiters", board: b, r: await srSearch(b, keywords) })),
    ...slugs.slice(0, 2).map(async (b): Promise<Attempt> => ({ ats: "workable", board: b, r: await workableSearch(b, keywords) })),
    ...slugs.slice(0, 2).map(async (b): Promise<Attempt> => ({ ats: "recruitee", board: b, r: await recruiteeSearch(b) })),
  ];
  const found = (await Promise.all(attempts.map((p) => p.catch(() => null)))).filter(
    (x): x is { ats: MoreAts; board: string; r: BoardPool } => !!x?.r && x.r.total > 0,
  );
  return found.sort((a, b) => b.r.total - a.r.total)[0] ?? null;
}

// ---------- careers pages and arbitrary job pages ----------

async function fetchHtml(url: string): Promise<{ html: string; finalUrl: string } | null> {
  try {
    const res = await fetch(url, { headers: { accept: "text/html", ...UA }, redirect: "follow", cf: { cacheTtl: 1800 } });
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("html")) return null;
    const html = await res.text();
    return { html: html.slice(0, 2_000_000), finalUrl: res.url };
  } catch {
    return null;
  }
}

// Find which job board a careers page embeds or links to.
const BOARD_PATTERNS: RegExp[] = [
  /https?:\/\/(?:boards|job-boards)\.greenhouse\.io\/embed\/job_board(?:\/js)?\?for=([\w-]+)/,
  /https?:\/\/(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/([\w-]+)(?=[/"'?#\s])/,
  /https?:\/\/jobs(?:\.eu)?\.lever\.co\/([\w-]+)/,
  /https?:\/\/jobs\.ashbyhq\.com\/([\w.-]+)/,
  /https?:\/\/[\w-]+\.wd\d+\.myworkday(?:jobs|site)\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?[\w-]+/,
  /https?:\/\/(?:careers|jobs)\.smartrecruiters\.com\/([\w-]+)/,
  /https?:\/\/apply\.workable\.com\/([\w-]+)/,
  /https?:\/\/([\w-]+)\.recruitee\.com/,
  /https?:\/\/[\w.-]+\.oraclecloud\.com\/hcmUI\/CandidateExperience\/[\w-]+\/sites\/[\w-]+/,
];

// Without a URL: try the company's usual careers pages (example.com/careers, careers.example.com …).
export async function discoverFromName(company: string): Promise<string | null> {
  const slug = company.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]/g, "");
  if (!slug) return null;
  const candidates = [`https://www.${slug}.com/careers`, `https://careers.${slug}.com/`, `https://${slug}.com/jobs`];
  const found = await Promise.all(candidates.map((u) => discoverBoardUrl(u).catch(() => null)));
  return found.find(Boolean) ?? null;
}

export async function discoverBoardUrl(pageUrl: string): Promise<string | null> {
  const page = await fetchHtml(pageUrl);
  if (!page) return null;
  for (const re of BOARD_PATTERNS) {
    const m = re.exec(page.html);
    if (!m) continue;
    const hit = m[0];
    if (hit.includes("embed/job_board")) return `https://boards.greenhouse.io/${m[1]}`;
    if (/greenhouse\.io\/(embed|js|api)$/.test(hit)) continue;
    return hit;
  }
  return null;
}

// Read any job page: schema.org JobPosting (what Google Jobs uses), else the page text.
export async function readJobPage(url: string): Promise<JobDetails | null> {
  const page = await fetchHtml(url);
  if (!page) return null;
  const blocks = [...page.html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]!);
  const postings: any[] = [];
  const walk = (v: any) => {
    if (!v || typeof v !== "object") return;
    if (Array.isArray(v)) return v.forEach(walk);
    const t = v["@type"];
    if (t === "JobPosting" || (Array.isArray(t) && t.includes("JobPosting"))) postings.push(v);
    if (v["@graph"]) walk(v["@graph"]);
  };
  for (const b of blocks) {
    try {
      walk(JSON.parse(b.trim()));
    } catch {
      // ignore invalid JSON-LD
    }
  }
  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(page.html)?.[1] ?? "").trim();
  if (postings[0]) {
    const p = postings[0];
    const locs = (Array.isArray(p.jobLocation) ? p.jobLocation : [p.jobLocation])
      .filter(Boolean)
      .map((l: any) => [l.address?.addressLocality, l.address?.addressRegion, l.address?.addressCountry?.name ?? l.address?.addressCountry].filter(Boolean).join(", "))
      .filter(Boolean);
    return {
      ats: "page",
      board: p.hiringOrganization?.name ?? new URL(page.finalUrl).hostname,
      id: page.finalUrl,
      title: p.title ?? title,
      location: locs.join("; ") + (p.jobLocationType === "TELECOMMUTE" ? " (Remote)" : ""),
      department: p.occupationalCategory,
      url: p.url ?? page.finalUrl,
      applyUrl: p.directApply === false ? page.finalUrl : (p.url ?? page.finalUrl),
      updatedAt: p.datePosted,
      description: htmlToText(String(p.description ?? "")),
    };
  }
  const body = htmlToText(page.html.replace(/<(script|style|nav|header|footer)[\s\S]*?<\/\1>/gi, ""));
  if (body.length < 200) return null;
  return {
    ats: "page",
    board: new URL(page.finalUrl).hostname,
    id: page.finalUrl,
    title: htmlToText(title),
    location: "",
    url: page.finalUrl,
    applyUrl: page.finalUrl,
    description: body,
  };
}
