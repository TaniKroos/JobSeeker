// Live job search against the public job-board APIs of common applicant tracking systems.

export type Ats = "greenhouse" | "lever" | "ashby" | "oracle" | "workday" | "smartrecruiters" | "workable" | "recruitee" | "page";

export interface JobSummary {
  ats: Ats;
  board: string; // the company's board slug on that ATS
  id: string;
  title: string;
  location: string;
  department?: string;
  url: string;
  applyUrl?: string; // page with the application form, when different from url
  updatedAt?: string;
  postedAt?: string; // ISO date the job was first posted (best available per board)
  postedApprox?: boolean; // true when the board only says e.g. "30+ days ago"
}

export interface JobDetails extends JobSummary {
  applyUrl: string;
  description: string;
  questions?: { label: string; required: boolean; type: string; options?: string[] }[];
}

const CACHE_SECONDS = 30 * 60;

async function getJson(url: string): Promise<any | null> {
  const res = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "JobSeeker/1.0 (+https://jobs.smudgee.xyz)" },
    cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true },
  });
  if (!res.ok) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export function htmlToText(html: string): string {
  return html
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/<(br|\/p|\/li|\/h\d|\/div)\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

// "Razorpay Software" -> ["razorpaysoftware", "razorpay-software", "razorpay"]
export function boardCandidates(company: string): string[] {
  const words = company
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s-]/g, "")
    .split(/[\s-]+/)
    .filter(Boolean);
  const set = new Set<string>();
  if (words.length) {
    set.add(words.join(""));
    set.add(words.join("-"));
    set.add(words[0]);
  }
  return [...set].slice(0, 3);
}

// Companies like Stripe host Greenhouse jobs on their own site; the embeddable form on
// greenhouse.io goes straight to the application (and the extension runs there).
export const greenhouseApplyUrl = (board: string, id: string, absolute: string) =>
  /greenhouse\.io/.test(absolute) ? absolute : `https://job-boards.greenhouse.io/embed/job_app?for=${board}&token=${id}`;

async function greenhouseJobs(board: string): Promise<JobSummary[] | null> {
  const data = await getJson(`https://boards-api.greenhouse.io/v1/boards/${board}/jobs`);
  if (!data?.jobs) return null;
  return data.jobs.map((j: any) => ({
    ats: "greenhouse" as const,
    board,
    id: String(j.id),
    title: j.title,
    location: j.location?.name ?? "",
    department: j.departments?.[0]?.name,
    url: j.absolute_url,
    applyUrl: greenhouseApplyUrl(board, String(j.id), j.absolute_url),
    updatedAt: j.updated_at,
    postedAt: j.first_published ?? j.updated_at,
  }));
}

async function leverJobs(board: string): Promise<JobSummary[] | null> {
  for (const host of ["api.lever.co", "api.eu.lever.co"]) {
    const data = await getJson(`https://${host}/v0/postings/${board}?mode=json`);
    if (Array.isArray(data) && data.length) {
      return data.map((j: any) => ({
        ats: "lever" as const,
        board,
        id: j.id,
        title: j.text,
        location: j.categories?.allLocations?.join(", ") || j.categories?.location || "",
        department: j.categories?.team,
        url: j.hostedUrl,
        applyUrl: `${j.hostedUrl}/apply`,
        updatedAt: j.createdAt ? new Date(j.createdAt).toISOString() : undefined,
        postedAt: j.createdAt ? new Date(j.createdAt).toISOString() : undefined,
      }));
    }
  }
  return null;
}

async function ashbyJobs(board: string): Promise<JobSummary[] | null> {
  const data = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${board}`);
  if (!data?.jobs) return null;
  return data.jobs
    .filter((j: any) => j.isListed !== false)
    .map((j: any) => ({
      ats: "ashby" as const,
      board,
      id: j.id,
      title: j.title,
      location: [j.location, ...(j.secondaryLocations ?? []).map((l: any) => l.location)]
        .filter(Boolean)
        .join(", ") + (j.isRemote ? " (Remote)" : ""),
      department: j.department,
      url: j.jobUrl,
      applyUrl: `${j.jobUrl}/application`,
      updatedAt: j.publishedAt,
      postedAt: j.publishedAt,
    }));
}

const fetchers: Record<"greenhouse" | "lever" | "ashby", (board: string) => Promise<JobSummary[] | null>> = {
  greenhouse: greenhouseJobs,
  lever: leverJobs,
  ashby: ashbyJobs,
};

// Parse a careers/job URL into its ATS, board and (optional) job id.
export function parseJobUrl(raw: string): { ats: Ats; board: string; id?: string } | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const parts = u.pathname.split("/").filter(Boolean);
  if (/(^|\.)greenhouse\.io$/.test(u.hostname)) {
    // boards.greenhouse.io/{board}/jobs/{id}, job-boards.greenhouse.io/{board}/jobs/{id}, ?for=board
    const board = parts[0] === "embed" ? u.searchParams.get("for") : parts[0];
    if (!board) return null;
    const id = parts[1] === "jobs" ? parts[2] : (u.searchParams.get("token") ?? undefined);
    return { ats: "greenhouse", board, id };
  }
  if (/(^|\.)lever\.co$/.test(u.hostname) && parts[0]) {
    return { ats: "lever", board: parts[0], id: parts[1] };
  }
  if (u.hostname === "jobs.ashbyhq.com" && parts[0]) {
    return { ats: "ashby", board: parts[0], id: parts[1] };
  }
  const oracle = /\/sites\/([^/]+)(?:\/job\/(\d+))?/.exec(u.pathname);
  if (u.hostname.endsWith(".oraclecloud.com") && oracle) {
    return { ats: "oracle", board: `${u.hostname}/${oracle[1]}`, id: oracle[2] };
  }
  return null;
}

export async function findBoards(companyOrUrl: string): Promise<JobSummary[] | null> {
  const parsed = parseJobUrl(companyOrUrl);
  if (parsed && parsed.ats in fetchers) return fetchers[parsed.ats as keyof typeof fetchers](parsed.board);

  // Try every ATS for every slug guess in parallel; take the board with the most jobs.
  const attempts = boardCandidates(companyOrUrl).flatMap((board) =>
    (Object.keys(fetchers) as (keyof typeof fetchers)[]).map((ats) => fetchers[ats](board).catch(() => null)),
  );
  const results = (await Promise.all(attempts)).filter((r): r is JobSummary[] => !!r && r.length > 0);
  if (!results.length) return null;
  return results.sort((a, b) => b.length - a.length)[0];
}

export function filterJobs(jobs: JobSummary[], keywords?: string, location?: string): JobSummary[] {
  const words = (keywords ?? "")
    .toLowerCase()
    .split(/[\s,]+/)
    .filter((w) => w.length > 1);
  const loc = location?.toLowerCase().trim();
  return jobs.filter((j) => {
    const hay = `${j.title} ${j.department ?? ""}`.toLowerCase();
    const kwOk = !words.length || words.some((w) => hay.includes(w));
    const locOk = !loc || j.location.toLowerCase().includes(loc) || (loc === "remote" && /remote/i.test(j.location));
    return kwOk && locOk;
  });
}

export async function getJobDetails(ats: Ats, board: string, id: string): Promise<JobDetails | null> {
  if (ats === "oracle") return oracleJobDetails(board, id);
  if (ats === "greenhouse") {
    const j = await getJson(`https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${id}?questions=true`);
    if (!j?.id) return null;
    const questions = (j.questions ?? []).map((q: any) => {
      const f = q.fields?.[0] ?? {};
      return {
        label: q.label,
        required: !!q.required,
        type: f.type ?? "input_text",
        options: f.values?.length ? f.values.map((v: any) => v.label) : undefined,
      };
    });
    return {
      ats,
      board,
      id: String(j.id),
      title: j.title,
      location: j.location?.name ?? "",
      department: j.departments?.[0]?.name,
      url: j.absolute_url,
      applyUrl: greenhouseApplyUrl(board, String(j.id), j.absolute_url),
      updatedAt: j.updated_at,
      description: htmlToText(j.content ?? ""),
      questions,
    };
  }
  if (ats === "lever") {
    for (const host of ["api.lever.co", "api.eu.lever.co"]) {
      const j = await getJson(`https://${host}/v0/postings/${board}/${id}`);
      if (!j?.id) continue;
      const lists = (j.lists ?? [])
        .map((l: any) => `${l.text}\n${htmlToText(l.content ?? "")}`)
        .join("\n\n");
      return {
        ats,
        board,
        id: j.id,
        title: j.text,
        location: j.categories?.allLocations?.join(", ") || j.categories?.location || "",
        department: j.categories?.team,
        url: j.hostedUrl,
        applyUrl: j.applyUrl ?? `${j.hostedUrl}/apply`,
        description: [j.descriptionPlain, lists, j.additionalPlain].filter(Boolean).join("\n\n").trim(),
      };
    }
    return null;
  }
  // Ashby has no single-job endpoint; read it from the board.
  const data = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${board}`);
  const j = data?.jobs?.find((x: any) => x.id === id);
  if (!j) return null;
  return {
    ats,
    board,
    id: j.id,
    title: j.title,
    location: j.location ?? "",
    department: j.department,
    url: j.jobUrl,
    applyUrl: j.applyUrl ?? `${j.jobUrl}/application`,
    updatedAt: j.publishedAt,
    description: j.descriptionPlain ?? htmlToText(j.descriptionHtml ?? ""),
  };
}

const labelKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

// Dropdown options for a Greenhouse application (custom + EEO questions), keyed by normalized label.
// The page renders these as custom dropdowns whose options the extension can't see until opened.
export async function greenhouseOptions(board: string, id: string): Promise<Map<string, string[]>> {
  const j = await getJson(`https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${id}?questions=true`);
  const map = new Map<string, string[]>();
  const add = (q: any) => {
    const values = q?.fields?.[0]?.values;
    if (q?.label && values?.length) map.set(labelKey(q.label), values.map((v: any) => v.label));
  };
  (j?.questions ?? []).forEach(add);
  (j?.location_questions ?? []).forEach(add);
  for (const c of j?.compliance ?? []) (c.questions ?? []).forEach(add);
  for (const q of j?.demographic_questions?.questions ?? []) {
    if (q.label && q.answer_options?.length) map.set(labelKey(q.label), q.answer_options.map((o: any) => o.label));
  }
  return map;
}

export function optionsForLabel(map: Map<string, string[]>, label: string): string[] | undefined {
  const key = labelKey(label);
  if (map.has(key)) return map.get(key);
  for (const [k, v] of map) if (k.length > 12 && (key.startsWith(k) || k.startsWith(key))) return v;
  return undefined;
}

// ---------- Oracle Recruiting Cloud (JPMorgan and many large companies) ----------
// Board format: "<host>/<siteNumber>", e.g. "jpmc.fa.oraclecloud.com/CX_1001".


export function oracleBoardFor(companyOrUrl: string): string | null {
  try {
    const u = new URL(companyOrUrl);
    const m = /\/sites\/([^/]+)/.exec(u.pathname);
    if (u.hostname.endsWith(".oraclecloud.com") && m) return `${u.hostname}/${m[1]}`;
  } catch {
    // not a URL
  }
  return null;
}

const oracleParts = (board: string) => {
  const [host, site] = board.split("/");
  return { host: host!, site: site! };
};
const oracleJobUrl = (board: string, id: string) => {
  const { host, site } = oracleParts(board);
  return `https://${host}/hcmUI/CandidateExperience/en/sites/${site}/job/${id}`;
};

async function oracleQuery(board: string, finder: Record<string, string | number>, expand: string) {
  const { host, site } = oracleParts(board);
  const f = Object.entries({ siteNumber: site, ...finder })
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join(",");
  return getJson(`https://${host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&expand=${expand}&finder=findReqs;${f}`);
}

// Keyword and location filtering happen on Oracle's side (these boards have thousands of jobs).
export async function searchOracle(
  board: string,
  keywords: string | undefined,
  location: string | undefined,
  limit: number,
  offset = 0,
): Promise<{ total: number; jobs: JobSummary[]; locationNote?: string } | null> {
  const base: Record<string, string | number> = { limit, offset, sortBy: "POSTING_DATES_DESC" };
  if (keywords) base.keyword = keywords;
  let locationNote: string | undefined;
  if (location) {
    const facets = await oracleQuery(board, { ...base, limit: 1, offset: 0, facetsList: "LOCATIONS" }, "locationsFacet");
    const list: { Id: number; Name: string }[] = facets?.items?.[0]?.locationsFacet ?? [];
    const want = location.toLowerCase().replace(/^bangalore\b/, "bengaluru");
    const hit =
      list.find((l) => l.Name.toLowerCase() === want) ??
      list.find((l) => l.Name.toLowerCase().startsWith(want + ",")) ??
      list.find((l) => l.Name.toLowerCase().split(/,\s*/).includes(want));
    if (hit) base.selectedLocationsFacet = hit.Id;
    else locationNote = `No jobs matching "${location}"; showing all locations.`;
  }
  const data = await oracleQuery(board, base, "requisitionList.secondaryLocations");
  const item = data?.items?.[0];
  if (!item) return null;
  return {
    total: item.TotalJobsCount ?? 0,
    locationNote,
    jobs: (item.requisitionList ?? []).map((r: any) => ({
      ats: "oracle" as Ats,
      board,
      id: String(r.Id),
      title: r.Title,
      location: [r.PrimaryLocation, ...(r.secondaryLocations ?? []).map((l: any) => l.Name)].filter(Boolean).join("; "),
      department: r.JobFamily ?? undefined,
      url: oracleJobUrl(board, String(r.Id)),
      updatedAt: r.PostedDate,
      postedAt: r.PostedDate,
    })),
  };
}

export async function oracleJobDetails(board: string, id: string): Promise<JobDetails | null> {
  const { host, site } = oracleParts(board);
  const data = await getJson(
    `https://${host}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails?expand=all&onlyData=true&finder=ById;Id=%22${encodeURIComponent(id)}%22,siteNumber=${site}`,
  );
  const j = data?.items?.[0];
  if (!j?.Id) return null;
  const sections = [
    j.ExternalDescriptionStr,
    j.ExternalResponsibilitiesStr && `Responsibilities:\n${htmlToText(j.ExternalResponsibilitiesStr)}`,
    j.ExternalQualificationsStr && `Qualifications:\n${htmlToText(j.ExternalQualificationsStr)}`,
  ].filter(Boolean);
  const url = oracleJobUrl(board, String(j.Id));
  return {
    ats: "oracle" as Ats,
    board,
    id: String(j.Id),
    title: j.Title,
    location: j.PrimaryLocation ?? "",
    department: j.Category ?? undefined,
    url,
    applyUrl: url,
    updatedAt: j.ExternalPostedStartDate,
    description: htmlToText(sections.join("\n\n")),
  };
}
