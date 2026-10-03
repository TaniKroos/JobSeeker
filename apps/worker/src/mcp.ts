// The MCP server Claude / ChatGPT talk to. One server instance per request (stateless).

import { McpServer } from "@modelcontextprotocol/server";
import { getMcpAuthContext } from "agents/mcp/server";
import { env } from "cloudflare:workers";
import { z } from "zod";
import type { FormField } from "@job-copilot/shared";
import type { FillOutcome, FormRecord } from "./room";
import { suggestFor } from "./suggest";
import {
  STATUSES,
  deleteUserData,
  listAnswers,
  type SavedAnswer,
  applicationsToCsv,
  deleteAnswer,
  deleteApplication,
  getProfile,
  listApplications,
  saveAnswer,
  searchAnswers,
  updateApplication,
  updateProfile,
  upsertApplication,
  type Application,
} from "./db";
import { detailsMore, discoverBoardUrl, discoverFromName, guessMore, parseMoreUrl, readJobPage, searchMore, type MoreAts } from "./boards";
import { boardCandidates, filterJobs, findBoards, getJobDetails, greenhouseOptions, optionsForLabel, oracleBoardFor, parseJobUrl, searchOracle, type JobDetails, type JobSummary } from "./jobs";

const INSTRUCTIONS = `Job Copilot helps the user find jobs, fill job applications in their browser, and track applications.

Typical flow:
1. Find jobs: search_jobs with a company name or any careers / job URL. It supports Greenhouse, Lever, Ashby, Workday, SmartRecruiters, Workable, Recruitee and Oracle Recruiting Cloud, and detects the board from a careers page or from any single job posting URL. If a name isn't enough, it tells you what to web-search for; then pass the URL you find. get_job reads any job page. Show title, location and link; compare get_job's description with get_profile when asked about fit.
2. When the user picks a job: track_application with status "Applying", then give them the apply_url (the page with the form; fall back to url). You cannot open tabs.
3. The Job Copilot Chrome extension captures the form automatically. When the user says "fill it": call get_open_forms. Fields with a "suggested" value are already matched to the profile and saved answers; fill_form fills those by default, so only send answers for the remaining fields (use find_saved_answers for long questions). If get_open_forms shows job_pages_without_form, the user still has to click Apply.
4. Multi-step forms (Workday, Oracle/JPMorgan, …): ask once whether the user wants you to move through the pages for them. If yes, use fill_form with advance=true; the response contains next_page, so keep filling page after page in the same turn. Otherwise call wait_for_next_page after each fill while they click Next. Never submit: stop at the final review/submit page.
5. Tell the user which fields still need them (resume upload, anything you were unsure of). They review and click Submit; the extension then marks the application "Applied".

Rules:
- Never invent facts (CTC, notice period, visa status, years of experience, demographic answers, dates). If the profile lacks a required fact, ask the user, then save it with update_profile so it is suggested next time.
- Voluntary demographic/EEO questions are suggested as "decline to answer" unless the user says otherwise.
- When the user approves a good long answer, save it with save_answer.
- Keep answers within any maxLength and pick select/radio/checkbox values exactly from the listed options.`;

function userId(): string {
  const id = getMcpAuthContext()?.props?.userId;
  if (typeof id !== "string" || !id) throw new Error("Not signed in");
  return id;
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const json = (v: unknown) => text(JSON.stringify(v, null, 2));
const err = (t: string) => ({ content: [{ type: "text" as const, text: t }], isError: true });

const room = () => env.USER_ROOM.get(env.USER_ROOM.idFromName(userId()));

const fmtDate = (ms: number | null) => (ms ? new Date(ms).toISOString().slice(0, 10) : null);
const appView = (a: Application) => ({
  id: a.id,
  company: a.company,
  role: a.role,
  status: a.status,
  applied_on: fmtDate(a.applied_at),
  next_step: a.next_step,
  next_step_date: a.next_step_date,
  notes: a.notes,
  url: a.url,
  updated: fmtDate(a.updated_at),
});

const fieldView = (f: FormField) => ({
  id: f.id,
  label: f.label,
  kind: f.kind,
  ...(f.inputType && f.inputType !== "text" ? { type: f.inputType } : {}),
  ...(f.required ? { required: true } : {}),
  ...(f.options?.length ? { options: f.options } : {}),
  ...(f.value && (Array.isArray(f.value) ? f.value.length : f.value.trim()) ? { current: f.value } : {}),
  ...(f.maxLength ? { maxLength: f.maxLength } : {}),
});

const statusEnum = z.enum(STATUSES);
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");

const MORE: MoreAts[] = ["workday", "smartrecruiters", "workable", "recruitee"];

const jobView = (j: JobSummary) => ({
  title: j.title,
  location: j.location,
  ...(j.department ? { team: j.department } : {}),
  url: j.url,
  ...(j.applyUrl && j.applyUrl !== j.url ? { apply_url: j.applyUrl } : {}),
  job_ref: `${j.ats}:${j.board}:${j.id}`,
  ...(j.updatedAt ? { posted: String(j.updatedAt).slice(0, 10) } : {}),
});

const isUrl = (s: string) => /^https?:\/\//i.test(s.trim());

// Find the company's board and search it. Returns a result object or a message for Claude.
async function searchCompany(company: string, keywords: string | undefined, location: string | undefined, limit: number, depth: number): Promise<object | string> {
  const input = company.trim();

  const oracle = oracleBoardFor(input);
  if (oracle) {
    const r = await searchOracle(oracle, keywords, location, limit);
    if (!r) return "The company's Oracle careers site did not respond. Try again in a minute.";
    return { board: `oracle:${oracle}`, matching: r.total, ...(r.locationNote ? { note: r.locationNote } : {}), jobs: r.jobs.map(jobView) };
  }

  const more = isUrl(input) ? parseMoreUrl(input) : null;
  if (more) {
    const r = await searchMore(more.ats, more.board, keywords, location, limit);
    if (!r) return `The ${more.ats} board did not return jobs. Check the URL.`;
    return { board: `${more.ats}:${more.board}`, total_open_roles: r.total, matching: r.jobs.length, jobs: r.jobs.map(jobView) };
  }

  if (isUrl(input) && !parseJobUrl(input)) {
    // An unknown careers page: find the board it uses, else read it as a single job posting.
    if (depth === 0) {
      const boardUrl = await discoverBoardUrl(input);
      if (boardUrl) return searchCompany(boardUrl, keywords, location, limit, 1);
    }
    const page = await readJobPage(input);
    if (page && page.description.length > 300) {
      return { board: `page:${page.board}`, note: "This is a single job page, not a job board.", jobs: [{ ...jobView(page), job_ref: undefined }] };
    }
    return "Couldn't find a job board on that page. Ask the user for the link to a specific job, or search the web for the role; the extension can still fill the application on any site.";
  }

  const jobs = await findBoards(input);
  if (jobs) {
    const matches = filterJobs(jobs, keywords, location);
    return { board: `${jobs[0]!.ats}:${jobs[0]!.board}`, total_open_roles: jobs.length, matching: matches.length, jobs: matches.slice(0, limit).map(jobView) };
  }
  if (!isUrl(input)) {
    const guess = await guessMore(boardCandidates(input), input, keywords, location, limit);
    if (guess?.r) return { board: `${guess.ats}:${guess.board}`, total_open_roles: guess.r.total, matching: guess.r.jobs.length, jobs: guess.r.jobs.map(jobView) };
    if (depth === 0) {
      const found = await discoverFromName(input);
      if (found) return searchCompany(found, keywords, location, limit, 1);
    }
  }
  return `No job board found for "${company}" from its name. Use web search to find ONE job posting or the job board of ${company} — e.g. search: ${company} careers (myworkdayjobs OR greenhouse OR lever OR ashbyhq OR smartrecruiters OR workable OR oraclecloud) — and call search_jobs again with that URL. Any single job URL on a job board is enough: the whole board is detected from it. If the company uses an unsupported system, get_job can still read any job page and the extension can fill the application.`;
}

async function jobDetails(job: string): Promise<JobDetails | null> {
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

export function createServer() {
  const server = new McpServer(
    { name: "job-copilot", title: "Job Copilot", version: "0.1.0" },
    { instructions: INSTRUCTIONS },
  );

  // ---------- jobs ----------

  server.registerTool(
    "search_jobs",
    {
      title: "Search a company's open jobs",
      description:
        "Live open roles from a company's job board: Greenhouse, Lever, Ashby, Workday, SmartRecruiters, Workable, Recruitee and Oracle (e.g. JPMorgan). Pass a company name (e.g. 'Stripe', 'NVIDIA', 'JPMorgan') or any careers/job-board URL (the board is detected from the page). Optionally filter by keywords and location.",
      inputSchema: z.object({
        company: z.string().min(1).describe("Company name, board slug, or careers / job board URL"),
        keywords: z.string().optional().describe("e.g. 'backend engineer'"),
        location: z.string().optional().describe("e.g. 'Bangalore', 'India', 'Remote'"),
        limit: z.number().int().min(1).max(50).default(20),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ company, keywords, location, limit }) => {
      const r = await searchCompany(company, keywords, location, limit, 0);
      return typeof r === "string" ? text(r) : json(r);
    },
  );

  server.registerTool(
    "get_job",
    {
      title: "Get job details",
      description:
        "Full description and requirements of one job (for Greenhouse also the application questions). Pass the job_ref from search_jobs, or ANY job posting URL: known boards use their API, other career sites are read directly from the page.",
      inputSchema: z.object({ job: z.string().min(1).describe("job_ref (ats:board:id) or a job posting URL") }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ job }) => {
      const d = await jobDetails(job);
      if (!d) return err("Could not read that job. It may have closed, or the page blocks automated reading; ask the user to paste the description.");
      const maxDesc = 8000;
      return json({
        title: d.title,
        company: d.ats === "page" ? d.board : undefined,
        location: d.location,
        team: d.department,
        url: d.url,
        apply_url: d.applyUrl,
        description: d.description.length > maxDesc ? d.description.slice(0, maxDesc) + "…" : d.description,
        application_questions: d.questions,
      });
    },
  );

  // ---------- profile & saved answers ----------

  server.registerTool(
    "get_profile",
    {
      title: "Get the user's profile",
      description:
        "The user's saved application facts (name, contact, links, education, experience summary, notice period, expected CTC, work authorization, preferences…).",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const p = await getProfile(env.DB, userId());
      return Object.keys(p).length ? json(p) : text("Profile is empty. Ask the user for the basics (or read their resume if they share it) and save them with update_profile.");
    },
  );

  server.registerTool(
    "update_profile",
    {
      title: "Update the user's profile",
      description:
        "Merge facts into the profile. Use these keys so forms get pre-filled: full_name, first_name, last_name, preferred_name, email, phone, city, country, linkedin, github, portfolio, current_company, current_title, years_experience, notice_period, current_ctc, expected_ctc, college, degree, graduation_year, cgpa, work_authorization (yes/no), requires_sponsorship (yes/no), willing_to_relocate (yes/no), work_preference (remote/hybrid/office), pronouns; plus free-form ones like skills, summary. Set a key to null to remove it. Only save what the user told you.",
      inputSchema: z.object({
        facts: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()])),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ facts }) => json(await updateProfile(env.DB, userId(), facts)),
  );

  server.registerTool(
    "find_saved_answers",
    {
      title: "Find saved answers",
      description:
        "Search answers the user wrote or approved before (e.g. 'why do you want to work here', 'describe a challenging project'). Reuse and adapt them for similar questions.",
      inputSchema: z.object({ question: z.string().min(1), limit: z.number().int().min(1).max(10).default(5) }),
      annotations: { readOnlyHint: true },
    },
    async ({ question, limit }) => {
      const found = await searchAnswers(env.DB, userId(), question, limit);
      return found.length
        ? json(found.map((a) => ({ id: a.id, question: a.question, answer: a.answer, source: a.source })))
        : text("No saved answers match.");
    },
  );

  server.registerTool(
    "save_answer",
    {
      title: "Save an answer",
      description: "Save (or replace) the user's answer to a question so it can be reused in future applications. Only save answers the user approved.",
      inputSchema: z.object({ question: z.string().min(3), answer: z.string().min(1) }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ question, answer }) => {
      await saveAnswer(env.DB, userId(), question, answer, "claude");
      return text("Saved.");
    },
  );

  server.registerTool(
    "delete_saved_answer",
    {
      title: "Delete a saved answer",
      description: "Delete one saved answer by id (from find_saved_answers).",
      inputSchema: z.object({ id: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ id }) => ((await deleteAnswer(env.DB, userId(), id)) ? text("Deleted.") : err("No such answer.")),
  );

  // ---------- browser forms ----------

  // Greenhouse dropdowns don't expose options in the page; fill them in from Greenhouse's API.
  async function enrich(rec: FormRecord): Promise<FormRecord> {
    const { form } = rec;
    const ref = form.site === "greenhouse" ? parseJobUrl(form.url) : null;
    if (ref?.id && form.fields.some((f) => f.kind === "select" && !f.options?.length)) {
      const opts = await greenhouseOptions(ref.board, ref.id).catch(() => new Map<string, string[]>());
      for (const f of form.fields) {
        if (f.kind === "select" && !f.options?.length) f.options = optionsForLabel(opts, f.label);
      }
    }
    return rec;
  }

  async function knowledge() {
    const uid = userId();
    const [profile, saved] = await Promise.all([getProfile(env.DB, uid), listAnswers(env.DB, uid)]);
    return { profile, saved };
  }

  function formView(rec: FormRecord, k: { profile: Record<string, unknown>; saved: SavedAnswer[] }) {
    const { form, lastFill } = rec;
    const fields = form.fields.map((f) => {
      const s = suggestFor(f, k.profile, k.saved);
      return { ...fieldView(f), ...(s ? { suggested: s.value, from: s.from } : {}) };
    });
    const open = fields.filter((f) => f.kind !== "file" && !("suggested" in f) && !("current" in f));
    return {
      form_id: form.formId,
      company: form.company,
      role: form.role,
      site: form.site,
      url: form.url,
      ...(form.step > 1 ? { page_step: form.step } : {}),
      fields_needing_your_answer: open.length,
      fields,
      ...(lastFill ? { last_fill: { at: new Date(lastFill.at).toISOString(), results: lastFill.results } } : {}),
    };
  }

  server.registerTool(
    "get_open_forms",
    {
      title: "Get open application forms",
      description:
        "Application forms the Chrome extension captured in the user's browser (most recent first): every field's id, label, kind, options, whether it is required, and a `suggested` value pre-matched from the profile/saved answers when one exists. Also lists job pages that are open without a form yet. Call this when the user asks to fill an application.",
      inputSchema: z.object({ form_id: z.string().optional().describe("Return only this form") }),
      annotations: { readOnlyHint: true },
    },
    async ({ form_id }) => {
      const r = room();
      const [status, forms, pages] = await Promise.all([r.status(), r.getForms(), r.getPages()]);
      const list = form_id ? forms.filter((f) => f.form.formId === form_id) : forms;
      const jobPages = pages.map((p) => ({
        url: p.url,
        title: p.title,
        company: p.company,
        role: p.role,
        ...(p.applyLink ? { apply_link: p.applyLink } : {}),
        has_apply_button: p.hasApplyButton,
      }));
      if (!list.length) {
        if (jobPages.length) {
          return json({
            extension_connected: status.extensionConnected,
            forms: [],
            job_pages_without_form: jobPages,
            hint: "The user is on a job description page, not the application form. Ask them to click Apply (or the 'Open application' button on the Job Copilot pill), then call get_open_forms again.",
          });
        }
        return text(
          status.extensionConnected
            ? "The extension is connected but no application form is open. Ask the user to open the job's application page (the apply_url from search_jobs), or, on a career site Job Copilot doesn't know, click the extension icon → 'Use on this page'. Then call get_open_forms again."
            : "No open forms and the Chrome extension is not connected. Ask the user to install the Job Copilot extension, click Connect, and open the application page.",
        );
      }
      const k = await knowledge();
      const recs = await Promise.all(list.map(enrich));
      return json({
        extension_connected: status.extensionConnected,
        forms: recs.map((rec) => formView(rec, k)),
        ...(jobPages.length ? { job_pages_without_form: jobPages } : {}),
      });
    },
  );

  function fillSummary(out: FillOutcome) {
    const results = out.results ?? [];
    const picked = results.filter((r) => r.status === "filled" && r.note);
    return {
      filled: results.filter((r) => r.status === "filled").length,
      ...(picked.length ? { check_these: picked.map((r) => ({ field_id: r.fieldId, label: r.label, note: r.note })) } : {}),
      not_filled: results.filter((r) => r.status !== "filled").map((r) => ({ field_id: r.fieldId, label: r.label, status: r.status, note: r.note })),
    };
  }

  server.registerTool(
    "fill_form",
    {
      title: "Fill an application form",
      description:
        "Fill an open form in the user's browser. By default every field's `suggested` value is filled too (fill_suggested), so only send answers for fields without a suggestion or where you want a different value. Values: for select/radio one of the options exactly, for checkbox an array of options; never file fields. With advance=true the extension clicks the page's Next/Continue button afterwards (never Submit) and the response includes the next page's fields, so you can fill multi-step forms in one go. The user always reviews and clicks Submit themselves.",
      inputSchema: z.object({
        form_id: z.string(),
        answers: z.array(z.object({ field_id: z.string(), value: z.union([z.string(), z.array(z.string())]) })).default([]),
        fill_suggested: z.boolean().default(true),
        advance: z.boolean().default(false).describe("Click Next/Continue after filling (multi-step forms). Never clicks Submit."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ form_id, answers, fill_suggested, advance }) => {
      const r = room();
      const rec = await r.getForm(form_id);
      if (!rec) return err("That form is no longer open (the page changed or was closed). Call get_open_forms to see the current page.");
      const merged = new Map(answers.map((a) => [a.field_id, a.value]));
      let k: Awaited<ReturnType<typeof knowledge>> | undefined;
      if (fill_suggested) {
        k = await knowledge();
        await enrich(rec);
        for (const f of rec.form.fields) {
          if (merged.has(f.id)) continue;
          const s = suggestFor(f, k.profile, k.saved);
          if (s) merged.set(f.id, s.value);
        }
      }
      if (!merged.size) return err("Nothing to fill: no answers given and no suggestions matched. Send answers for the fields.");
      const out = await r.fill(
        form_id,
        [...merged].map(([fieldId, value]) => ({ fieldId, value })),
        advance,
      );
      if (out.error && !out.results) return err(out.error);
      const next = out.nextForm ? formView(await enrich(out.nextForm), k ?? (await knowledge())) : undefined;
      return json({
        ...fillSummary(out),
        ...(advance
          ? {
              advanced: out.advance?.clicked ?? false,
              ...(out.advance?.button ? { clicked_button: out.advance.button } : {}),
              ...(out.advance?.note ? { advance_note: out.advance.note } : {}),
              ...(next ? { next_page: next } : out.advance?.clicked ? { next_page: null, hint: "Clicked Next but the new page hasn't been captured yet; call wait_for_next_page." } : {}),
            }
          : {}),
        reminder: next
          ? "Fill next_page the same way (fill_form with its form_id). Continue until the page with the final Submit button, then stop and let the user review and submit."
          : "If a dropdown failed and its note lists the options, call fill_form again for just that field with an exact option. Tell the user what still needs them (e.g. resume upload) and that they should review and click Submit.",
      });
    },
  );

  server.registerTool(
    "wait_for_next_page",
    {
      title: "Wait for the next page of a form",
      description:
        "For multi-step forms when the user clicks Next themselves: waits (up to ~50 s) until the extension captures the next page of the same application, then returns its fields. Call it right after fill_form when the user prefers to click Next; call it again if it times out and the user is still going.",
      inputSchema: z.object({ form_id: z.string(), timeout_seconds: z.number().int().min(5).max(55).default(50) }),
      annotations: { readOnlyHint: true },
    },
    async ({ form_id, timeout_seconds }) => {
      const next = await room().waitForNext(form_id, timeout_seconds * 1000);
      if (!next) return text("No new page yet. If the user is still on this page, ask them to click Next (or offer to do it with fill_form advance=true), then call wait_for_next_page again.");
      return json(formView(await enrich(next), await knowledge()));
    },
  );

  // ---------- tracker ----------

  server.registerTool(
    "track_application",
    {
      title: "Add or update a tracked application",
      description:
        "Add a job to the user's application tracker, or update it if the same job (same URL, or same company + role) is already tracked. Use status 'Applying' when the user decides to apply.",
      inputSchema: z.object({
        company: z.string().min(1),
        role: z.string().min(1),
        url: z.string().url().optional(),
        status: statusEnum.optional(),
        next_step: z.string().nullable().optional().describe("e.g. 'OA on HackerRank', 'HR call'"),
        next_step_date: dateStr.nullable().optional(),
        notes: z.string().nullable().optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (input) => {
      const { app, created } = await upsertApplication(env.DB, userId(), input);
      return json({ created, application: appView(app) });
    },
  );

  server.registerTool(
    "update_application",
    {
      title: "Update an application",
      description: "Change status, next step, notes etc. of a tracked application by id (from list_applications).",
      inputSchema: z.object({
        id: z.string(),
        company: z.string().optional(),
        role: z.string().optional(),
        url: z.string().url().optional(),
        status: statusEnum.optional(),
        next_step: z.string().nullable().optional(),
        next_step_date: dateStr.nullable().optional(),
        notes: z.string().nullable().optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ id, ...patch }) => {
      const app = await updateApplication(env.DB, userId(), id, patch);
      return app ? json(appView(app)) : err("No application with that id.");
    },
  );

  server.registerTool(
    "list_applications",
    {
      title: "List tracked applications",
      description:
        "The user's application tracker, most recently updated first. Filter by status or company. Use it for questions like 'what's due this week' or 'where haven't I heard back'.",
      inputSchema: z.object({ status: statusEnum.optional(), company: z.string().optional() }),
      annotations: { readOnlyHint: true },
    },
    async ({ status, company }) => {
      const apps = await listApplications(env.DB, userId(), { status, company });
      if (!apps.length) return text("No tracked applications yet.");
      const counts: Record<string, number> = {};
      for (const a of apps) counts[a.status] = (counts[a.status] ?? 0) + 1;
      return json({ today: new Date().toISOString().slice(0, 10), counts, applications: apps.map(appView) });
    },
  );

  server.registerTool(
    "delete_application",
    {
      title: "Delete a tracked application",
      description: "Remove an application from the tracker by id. Confirm with the user first.",
      inputSchema: z.object({ id: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ id }) => ((await deleteApplication(env.DB, userId(), id)) ? text("Deleted.") : err("No application with that id.")),
  );

  server.registerTool(
    "export_applications",
    {
      title: "Export the tracker as CSV",
      description:
        "The whole application tracker as CSV. If the user wants it in Google Sheets and you have a Google Drive tool, create a file from this CSV (it converts to a Sheet); otherwise show it or offer it as a download.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => text(applicationsToCsv(await listApplications(env.DB, userId()))),
  );

  server.registerTool(
    "delete_my_data",
    {
      title: "Delete all my Job Copilot data",
      description:
        "Permanently erase the user's profile, saved answers, application tracker and extension sign-ins. Only call this when the user explicitly asks to delete their data, after confirming; it cannot be undone.",
      inputSchema: z.object({ confirm: z.literal(true).describe("Must be true; confirm with the user first") }),
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async () => {
      await deleteUserData(env.DB, userId());
      return text("All Job Copilot data for this account was deleted. The browser extension is signed out; click Connect to use it again.");
    },
  );

  return server;
}
