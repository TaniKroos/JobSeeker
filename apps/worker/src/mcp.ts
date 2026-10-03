// The MCP server Claude / ChatGPT talk to. One server instance per request (stateless).
// Minimal data: facts about the user come from the assistant's own memory with each request
// (`facts`) and are never stored; the tracker keeps only company, role, URL, status, applied date.

import { McpServer } from "@modelcontextprotocol/server";
import { getMcpAuthContext } from "agents/mcp/server";
import { env } from "cloudflare:workers";
import { z } from "zod";
import type { FormField } from "@job-copilot/shared";
import {
  RETENTION_MS,
  STATUSES,
  applicationsToCsv,
  deleteApplication,
  deleteUserData,
  listApplications,
  updateApplication,
  upsertApplication,
  type Application,
} from "./db";
import { greenhouseOptions, optionsForLabel, parseJobUrl } from "./jobs";
import type { FillOutcome, FormRecord } from "./room";
import { jobDetails, searchCompany } from "./search";
import { suggestFor } from "./suggest";

const NAME = "JobSeeker";

// Sites whose applications span several pages: Next is clicked automatically after a clean fill.
const MULTI_STEP_SITES = new Set(["workday", "oracle", "successfactors", "taleo", "icims"]);

const FACT_KEYS =
  "full_name, first_name, last_name, preferred_name, email, phone, city, country, linkedin, github, portfolio, current_company, current_title, years_experience, notice_period, current_ctc, expected_ctc, college, degree, graduation_year, cgpa, work_authorization (yes/no), requires_sponsorship (yes/no), willing_to_relocate (yes/no), work_preference (remote/hybrid/office), pronouns";

const INSTRUCTIONS = `${NAME} helps the user find jobs, fill job applications in their browser, and track applications.

${NAME} stores almost nothing about the user. Keep what you learn about them (name, contact details, experience, notice period, CTC, visa/sponsorship status, preferences, good answers to common questions) in YOUR memory, and pass the relevant facts as \`facts\` to get_open_forms / fill_form; they are used for that request only and never saved.

Typical flow:
1. Find jobs: search_jobs with a company name or any careers / job URL (Greenhouse, Lever, Ashby, Workday, SmartRecruiters, Workable, Recruitee, Oracle; the board is detected from a careers page or any single job URL; if a name isn't enough it tells you what to web-search for). Results are the newest postings first, from the last 30 days by default (posted_within_days); use next_offset for more. get_job reads any job page; compare it with what you know about the user when asked about fit.
2. When the user picks a job: track_application with status "Applying", then give them the apply_url (the page with the form; fall back to url). You cannot open tabs.
3. The ${NAME} Chrome extension captures the form. When the user says "fill it": call get_open_forms with facts. Fields with a "suggested" value are matched already and fill_form fills them by default, so only send answers for the remaining fields. If get_open_forms shows job_pages_without_form, the user still has to click Apply (the extension pill has an "Open application" button).
4. Multi-page forms (multi_step: true, e.g. Workday, Oracle/JPMorgan): fill_form clicks Next/Continue for you after a clean fill and returns next_page; keep filling page after page in the same turn. Do NOT ask the user to click Next. Stop at the final review/submit page; never submit. If advance_note says required fields need the user, tell them which, then call wait_for_next_page (the extension continues once they're fixed).
5. Tell the user which fields still need them (resume upload, anything you were unsure of). They review and click Submit; the extension then marks the application "Applied".

Rules:
- Never invent facts (CTC, notice period, visa status, years of experience, demographic answers, dates). If you don't know a required fact, ask the user and remember it.
- Voluntary demographic/EEO questions are suggested as "decline to answer" unless the user says otherwise.
- Keep answers within any maxLength and pick select/radio/checkbox values exactly from the listed options.
- The tracker keeps only company, role, link, status and applied date, for 90 days after the last update. Keep notes (next steps, interview dates) in your memory.`;

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
  url: a.url,
  updated: fmtDate(a.updated_at),
  kept_until: fmtDate(a.updated_at + RETENTION_MS),
});

const fieldView = (f: FormField) => ({
  id: f.id,
  label: f.label,
  kind: f.kind,
  ...(f.inputType && f.inputType !== "text" ? { type: f.inputType } : {}),
  ...(f.required ? { required: true } : {}),
  ...(f.options?.length ? { options: f.options } : {}),
  ...(f.hasValue ? { already_answered: true } : {}),
  ...(f.maxLength ? { maxLength: f.maxLength } : {}),
});

const statusEnum = z.enum(STATUSES);
const factsSchema = z
  .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]))
  .optional()
  .describe(`Facts about the user from your memory, used only for this request (never stored). Keys: ${FACT_KEYS}.`);

type Facts = Record<string, unknown>;

const isMultiStep = (rec: FormRecord) => MULTI_STEP_SITES.has(rec.form.site) || rec.form.step > 1;

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

function formView(rec: FormRecord, facts: Facts) {
  const { form, lastFill } = rec;
  const fields = form.fields.map((f) => {
    const s = suggestFor(f, facts);
    return { ...fieldView(f), ...(s ? { suggested: s.value, from: s.from } : {}) };
  });
  const open = fields.filter((f) => f.kind !== "file" && !("suggested" in f) && !("already_answered" in f));
  const multi = isMultiStep(rec);
  if (form.final) {
    return {
      form_id: form.formId,
      company: form.company,
      role: form.role,
      site: form.site,
      url: form.url,
      final_review_page: true,
      note: "This is the final review page: nothing left to fill. Stop here and ask the user to review the application and click Submit themselves.",
    };
  }
  return {
    form_id: form.formId,
    company: form.company,
    role: form.role,
    site: form.site,
    url: form.url,
    ...(form.step > 1 ? { page_step: form.step } : {}),
    ...(multi
      ? {
          multi_step: true,
          multi_step_note: `This application has several pages. fill_form clicks Next for you after a clean fill and returns the next page — keep going page by page; don't ask the user to click Next.`,
        }
      : {}),
    fields_needing_your_answer: open.length,
    fields,
    ...(lastFill ? { last_fill: { at: new Date(lastFill.at).toISOString(), results: lastFill.results } } : {}),
  };
}

function fillSummary(out: FillOutcome) {
  const results = out.results ?? [];
  const picked = results.filter((r) => r.status === "filled" && r.note);
  return {
    filled: results.filter((r) => r.status === "filled").length,
    ...(picked.length ? { check_these: picked.map((r) => ({ field_id: r.fieldId, label: r.label, note: r.note })) } : {}),
    not_filled: results.filter((r) => r.status !== "filled").map((r) => ({ field_id: r.fieldId, label: r.label, status: r.status, note: r.note })),
  };
}

export function createServer() {
  const server = new McpServer({ name: "jobseeker", title: NAME, version: "1.0.0" }, { instructions: INSTRUCTIONS });

  // ---------- jobs ----------

  server.registerTool(
    "search_jobs",
    {
      title: "Search a company's open jobs",
      description:
        "Live open roles from a company's job board: Greenhouse, Lever, Ashby, Workday, SmartRecruiters, Workable, Recruitee and Oracle (e.g. JPMorgan). Pass a company name or any careers / job-board / job URL (the board is detected). Newest postings first; only the last `posted_within_days` days (default 30). Use next_offset to get more.",
      inputSchema: z.object({
        company: z.string().min(1).describe("Company name, board slug, or careers / job board / job URL"),
        keywords: z.string().optional().describe("e.g. 'backend engineer'"),
        location: z.string().optional().describe("e.g. 'Bangalore', 'India', 'Remote'"),
        posted_within_days: z.number().int().min(0).max(3650).default(30).describe("0 = any date"),
        limit: z.number().int().min(1).max(50).default(20),
        offset: z.number().int().min(0).default(0),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ company, keywords, location, posted_within_days, limit, offset }) => {
      const r = await searchCompany(company, { keywords, location, limit, offset, postedWithinDays: posted_within_days });
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
        ...(d.postedAt ? { posted: String(d.postedAt).slice(0, 10) } : {}),
        url: d.url,
        apply_url: d.applyUrl,
        description: d.description.length > maxDesc ? d.description.slice(0, maxDesc) + "…" : d.description,
        application_questions: d.questions,
      });
    },
  );

  // ---------- browser forms ----------

  server.registerTool(
    "get_open_forms",
    {
      title: "Get open application forms",
      description:
        "Application forms the Chrome extension captured in the user's browser (most recent first): every field's id, label, kind, options, whether it's required, and a `suggested` value matched from `facts` when possible. Also lists job pages open without a form yet. Call this when the user asks to fill an application, passing facts from your memory.",
      inputSchema: z.object({ form_id: z.string().optional().describe("Return only this form"), facts: factsSchema }),
      annotations: { readOnlyHint: true },
    },
    async ({ form_id, facts }) => {
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
            hint: "The user is on a job description page, not the application form. Ask them to click Apply (or 'Open application' on the JobSeeker pill), then call get_open_forms again.",
          });
        }
        return text(
          status.extensionConnected
            ? `The extension is connected but no application form is open. Ask the user to open the job's application page (the apply_url from search_jobs), or, on a career site ${NAME} doesn't know, click the extension icon → 'Use on this page'. Then call get_open_forms again.`
            : `No open forms and the ${NAME} Chrome extension is not connected. Ask the user to install the extension, click Connect, and open the application page.`,
        );
      }
      const recs = await Promise.all(list.map(enrich));
      return json({
        extension_connected: status.extensionConnected,
        forms: recs.map((rec) => formView(rec, facts ?? {})),
        ...(jobPages.length ? { job_pages_without_form: jobPages } : {}),
      });
    },
  );

  server.registerTool(
    "fill_form",
    {
      title: "Fill an application form",
      description:
        "Fill an open form in the user's browser. Every field's `suggested` value (from facts) is filled too unless fill_suggested is false, so only send answers for the other fields. Values: for select/radio one of the options exactly, for checkbox an array of options; never file fields. On multi-step forms the extension then clicks Next/Continue (never Submit) and the response includes next_page: keep filling. Pass advance=false only if the user wants to click Next themselves. The user always reviews and clicks Submit.",
      inputSchema: z.object({
        form_id: z.string(),
        answers: z.array(z.object({ field_id: z.string(), value: z.union([z.string(), z.array(z.string())]) })).default([]),
        facts: factsSchema,
        fill_suggested: z.boolean().default(true),
        advance: z.boolean().optional().describe("Click Next/Continue after filling. Defaults to true on multi-step forms. Never clicks Submit."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ form_id, answers, facts, fill_suggested, advance }) => {
      const r = room();
      const rec = await r.getForm(form_id);
      if (!rec) return err("That form is no longer open (the page changed or was closed). Call get_open_forms to see the current page.");
      if (rec.form.final) return text("This is the final review page: nothing to fill. Ask the user to review the application and click Submit themselves.");
      await enrich(rec);
      const merged = new Map(answers.map((a) => [a.field_id, a.value]));
      let suggested = 0;
      if (fill_suggested) {
        for (const f of rec.form.fields) {
          if (merged.has(f.id)) continue;
          const s = suggestFor(f, facts ?? {});
          if (s) {
            merged.set(f.id, s.value);
            suggested++;
          }
        }
      }
      const doAdvance = advance ?? isMultiStep(rec);
      if (!merged.size && !doAdvance) return err("Nothing to fill: no answers given and no suggestions matched. Send answers for the fields.");
      const out = await r.fill(
        form_id,
        [...merged].map(([fieldId, value]) => ({ fieldId, value })),
        doAdvance,
      );
      const summary = fillSummary(out);
      // Diagnostics only: no answers, no user data.
      console.log(
        JSON.stringify({
          evt: "fill_form",
          site: rec.form.site,
          step: rec.form.step,
          fields: rec.form.fields.length,
          answers: answers.length,
          suggested,
          advance_requested: advance ?? null,
          advance: doAdvance,
          clicked: out.advance?.clicked ?? null,
          advance_note: out.advance?.note ?? null,
          next_page: !!out.nextForm,
          filled: summary.filled,
          not_filled: summary.not_filled.length,
          error: out.error ?? null,
        }),
      );
      if (out.error && !out.results) return err(out.error);
      const next = out.nextForm ? formView(await enrich(out.nextForm), facts ?? {}) : undefined;
      return json({
        ...summary,
        ...(doAdvance
          ? {
              advanced: out.advance?.clicked ?? false,
              ...(out.advance?.button ? { clicked_button: out.advance.button } : {}),
              ...(out.advance?.note ? { advance_note: out.advance.note } : {}),
              ...(next ? { next_page: next } : out.advance?.clicked ? { next_page: null, hint: "Clicked Next but the new page hasn't been captured yet; call wait_for_next_page." } : {}),
            }
          : {}),
        reminder: next
          ? "Fill next_page the same way (fill_form with its form_id and facts). Continue until the final review/submit page, then stop and let the user review and submit."
          : "If a dropdown failed and its note lists the options, call fill_form again for just that field with an exact option. Tell the user what still needs them (e.g. resume upload) and that they should review and click Submit.",
      });
    },
  );

  server.registerTool(
    "wait_for_next_page",
    {
      title: "Wait for the next page of a form",
      description:
        "Waits (up to ~50 s) until the extension captures the next page of the same application, then returns its fields (with suggestions from facts). Use it when the user is fixing something or clicking Next themselves; call it again if it times out and the user is still going.",
      inputSchema: z.object({ form_id: z.string(), timeout_seconds: z.number().int().min(5).max(55).default(50), facts: factsSchema }),
      annotations: { readOnlyHint: true },
    },
    async ({ form_id, timeout_seconds, facts }) => {
      const next = await room().waitForNext(form_id, timeout_seconds * 1000);
      if (!next) return text("No new page yet. If the user is still on this page, they may need to fix highlighted fields; call wait_for_next_page again.");
      return json(formView(await enrich(next), facts ?? {}));
    },
  );

  // ---------- tracker ----------

  server.registerTool(
    "track_application",
    {
      title: "Add or update a tracked application",
      description:
        "Add a job to the user's tracker (company, role, link, status), or update it if the same job is already tracked. Use status 'Applying' when the user decides to apply. Entries are kept 90 days after their last update; keep notes in your memory.",
      inputSchema: z.object({ company: z.string().min(1), role: z.string().min(1), url: z.string().url().optional(), status: statusEnum.optional() }),
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
      description: "Change company, role, link or status of a tracked application by id (from list_applications).",
      inputSchema: z.object({ id: z.string(), company: z.string().optional(), role: z.string().optional(), url: z.string().url().optional(), status: statusEnum.optional() }),
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
      description: "The user's application tracker (last 90 days), most recently updated first. Filter by status or company.",
      inputSchema: z.object({ status: statusEnum.optional(), company: z.string().optional() }),
      annotations: { readOnlyHint: true },
    },
    async ({ status, company }) => {
      const apps = await listApplications(env.DB, userId(), { status, company });
      if (!apps.length) return text("No tracked applications in the last 90 days.");
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
        "The whole tracker as CSV. If the user wants it in Google Sheets and you have a Google Drive tool, create a file from this CSV (it converts to a Sheet); otherwise show it or offer it as a download.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => text(applicationsToCsv(await listApplications(env.DB, userId()))),
  );

  server.registerTool(
    "delete_my_data",
    {
      title: `Delete all my ${NAME} data`,
      description: `Permanently erase the user's application tracker and extension sign-ins. Only call this when the user explicitly asks to delete their data, after confirming; it cannot be undone.`,
      inputSchema: z.object({ confirm: z.literal(true).describe("Must be true; confirm with the user first") }),
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async () => {
      await deleteUserData(env.DB, userId());
      return text(`All ${NAME} data for this account was deleted. The browser extension is signed out; click Connect to use it again.`);
    },
  );

  return server;
}
