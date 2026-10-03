// End-to-end test against a running `wrangler dev` (default http://localhost:8787, DEV_PASSCODE login).
// Plays both sides: an MCP client (like Claude) and the Chrome extension (WebSocket).
// Usage: node scripts/e2e.mjs [baseUrl]

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import crypto from "node:crypto";

const BASE = process.argv[2] ?? "http://localhost:8787";
const PASSCODE = process.env.DEV_PASSCODE ?? "letmein";
const EMAIL = `e2e-${Date.now()}@example.com`;
const EXT_REDIRECT = "https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/cb";

let failures = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures++;
};
const b64url = (b) => Buffer.from(b).toString("base64url");
const cookiesFrom = (res) => res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

// ---------- 1. Connector OAuth (what Claude does) ----------
async function connectorToken(email = EMAIL) {
  const reg = await fetch(`${BASE}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "E2E Test Client",
      redirect_uris: ["https://client.example.com/callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  }).then((r) => r.json());
  ok(!!reg.client_id, "dynamic client registration");

  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const authUrl = new URL(`${BASE}/authorize`);
  Object.entries({
    response_type: "code",
    client_id: reg.client_id,
    redirect_uri: "https://client.example.com/callback",
    state: "xyz",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: `${BASE}/mcp`,
  }).forEach(([k, v]) => authUrl.searchParams.set(k, v));

  const page = await fetch(authUrl, { redirect: "manual" });
  const html = await page.text();
  const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1];
  ok(page.status === 200 && !!handle, "consent page renders with handle");
  ok(html.includes("E2E Test Client"), "consent page names the client");

  const post = await fetch(`${BASE}/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookiesFrom(page) },
    body: new URLSearchParams({ handle, method: "dev", email, passcode: PASSCODE }),
  });
  const loc = new URL(post.headers.get("location") ?? "about:blank");
  const code = loc.searchParams.get("code");
  ok(post.status === 302 && !!code && loc.searchParams.get("state") === "xyz", "dev sign-in redirects back with code");

  const tok = await fetch(`${BASE}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: "https://client.example.com/callback",
      client_id: reg.client_id,
      code_verifier: verifier,
      resource: `${BASE}/mcp`,
    }),
  }).then((r) => r.json());
  ok(!!tok.access_token, "token exchange");
  return tok.access_token;
}

// ---------- 2. Extension sign-in ----------
async function extensionToken() {
  const page = await fetch(`${BASE}/ext/login?redirect_uri=${encodeURIComponent(EXT_REDIRECT)}`);
  const html = await page.text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
  ok(page.status === 200 && !!csrf, "extension login page");
  const bad = await fetch(`${BASE}/ext/login?redirect_uri=${encodeURIComponent("https://evil.example.com/")}`);
  ok(bad.status === 400, "extension login rejects non-extension redirect");

  const post = await fetch(`${BASE}/ext/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookiesFrom(page) },
    body: new URLSearchParams({ csrf, method: "dev", email: EMAIL, passcode: PASSCODE }),
  });
  const loc = post.headers.get("location") ?? "";
  const hash = new URLSearchParams(loc.split("#")[1] ?? "");
  ok(loc.startsWith(EXT_REDIRECT) && !!hash.get("token"), "extension receives token via redirect");
  const me = await fetch(`${BASE}/ext/me`, { headers: { authorization: `Bearer ${hash.get("token")}` } }).then((r) => r.json());
  ok(me.email === EMAIL, "extension token identifies the same user");
  return hash.get("token");
}

// ---------- 3. Fake extension over WebSocket ----------
const FORM = {
  formId: "form-e2e-1",
  session: "sess-1",
  step: 1,
  url: "https://job-boards.greenhouse.io/acme/jobs/123",
  site: "greenhouse",
  company: "Acme",
  role: "Backend Engineer",
  pageTitle: "Job Application for Backend Engineer at Acme",
  capturedAt: Date.now(),
  fields: [
    { id: "f1", label: "First Name", kind: "text", required: true },
    { id: "f2", label: "Email", kind: "text", inputType: "email", required: true },
    { id: "f3", label: "Why do you want to work at Acme?", kind: "textarea", required: true },
    { id: "f4", label: "Notice period", kind: "select", required: false, options: ["Immediate", "30 days", "60 days"] },
    { id: "f5", label: "Resume/CV", kind: "file", required: true },
  ],
};

const PAGE2 = {
  formId: "form-e2e-p2",
  session: "sess-mp",
  step: 2,
  url: "https://acme.wd1.myworkdayjobs.com/Careers/job/X/apply/step2",
  site: "workday",
  company: "Acme",
  role: "Data Engineer",
  pageTitle: "Step 2",
  capturedAt: Date.now(),
  fields: [
    { id: "q1", label: "Will you now or in the future require sponsorship?", kind: "radio", required: true, options: ["Yes", "No"] },
    { id: "q2", label: "Years of experience", kind: "text", required: true },
  ],
};
const PAGE1 = {
  ...PAGE2,
  formId: "form-e2e-p1",
  step: 1,
  url: "https://acme.wd1.myworkdayjobs.com/Careers/job/X/apply",
  fields: [
    { id: "a1", label: "First Name", kind: "text", required: true },
    { id: "a2", label: "Last Name", kind: "text", required: true },
    { id: "a3", label: "Email Address", kind: "text", inputType: "email", required: true },
    { id: "a4", label: "Gender", kind: "select", required: false, options: ["Male", "Female", "I decline to self-identify"] },
    { id: "a5", label: "Are you legally authorized to work in India?", kind: "select", required: true, options: ["Yes", "No"] },
    { id: "a6", label: "Why Acme?", kind: "textarea", required: true },
  ],
};

function connectExtension(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/ext/ws?token=${encodeURIComponent(token)}`);
    const state = { ws, fills: [] };
    ws.onerror = (e) => reject(e);
    ws.onmessage = (ev) => {
      if (ev.data === "pong") {
        state.gotPong = true;
        return;
      }
      const msg = JSON.parse(ev.data);
      if (msg.type === "hello") {
        ws.send(JSON.stringify({ type: "form", form: FORM }));
        setTimeout(() => resolve(state), 300);
      }
      if (msg.type === "fill") {
        state.fills.push(msg);
        const results = FORM.fields.map((f) => {
          const a = msg.answers.find((x) => x.fieldId === f.id);
          if (f.kind === "file") return { fieldId: f.id, label: f.label, status: "needs_user", note: "Upload your resume" };
          return { fieldId: f.id, label: f.label, status: a ? "filled" : "skipped" };
        });
        if (msg.advance) {
          ws.send(JSON.stringify({ type: "fill_result", requestId: msg.requestId, formId: msg.formId, results, advance: { clicked: true, button: "Next" } }));
          // the next page of the same application appears a moment later
          setTimeout(() => ws.send(JSON.stringify({ type: "form", form: { ...PAGE2, capturedAt: Date.now() } })), 400);
        } else {
          ws.send(JSON.stringify({ type: "fill_result", requestId: msg.requestId, formId: msg.formId, results }));
        }
      }
    };
  });
}

// ---------- run ----------
const accessToken = await connectorToken();
const extToken = await extensionToken();

const rejected = await new Promise((resolve) => {
  const ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/ext/ws?token=nope`);
  ws.onopen = () => resolve(false);
  ws.onerror = () => resolve(true);
});
ok(rejected, "WebSocket rejects bad token");

const ext = await connectExtension(extToken);
ext.ws.send("ping");

const client = new Client({ name: "e2e", version: "0.0.1" });
await client.connect(
  new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
  }),
);
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const t = r.content?.[0]?.text ?? "";
  let parsed;
  try {
    parsed = JSON.parse(t);
  } catch {
    parsed = t;
  }
  return { isError: !!r.isError, data: parsed, text: t };
};

const tools = (await client.listTools()).tools.map((t) => t.name);
ok(tools.length >= 14, `lists ${tools.length} tools: ${tools.join(", ")}`);

// Jobs (live network)
const s = await call("search_jobs", { company: "stripe", keywords: "engineer", limit: 3 });
ok(!s.isError && s.data.jobs?.length > 0, `search_jobs stripe → ${s.data.matching ?? 0} matching of ${s.data.total_open_roles ?? 0}`);
if (s.data.jobs?.[0]) {
  const j = await call("get_job", { job: s.data.jobs[0].job_ref });
  ok(!j.isError && j.data.description?.length > 100, `get_job → "${j.data.title}" (${j.data.application_questions?.length ?? 0} questions)`);
}
const lever = await call("search_jobs", { company: "https://jobs.lever.co/palantir", limit: 2 });
ok(!lever.isError && lever.data.jobs?.length > 0, `search_jobs lever URL → ${lever.data.total_open_roles ?? 0} roles`);
const ashby = await call("search_jobs", { company: "ramp", limit: 2 });
ok(typeof ashby.data === "object" && ashby.data.jobs?.length > 0, `search_jobs ramp (ashby) → ${ashby.data.total_open_roles ?? ashby.text.slice(0, 60)}`);
const jpm = await call("search_jobs", { company: "https://www.jpmorganchase.com/careers", keywords: "software engineer", location: "Bangalore", limit: 3 });
ok(!jpm.isError && jpm.data.jobs?.length > 0 && jpm.data.jobs.every((j) => /Bengaluru/.test(j.location)), `search_jobs JPMorgan careers page → oracle detected, Bangalore → ${jpm.data.matching ?? jpm.text.slice(0, 80)}`);
if (jpm.data.jobs?.[0]) {
  const jd = await call("get_job", { job: jpm.data.jobs[0].job_ref });
  ok(!jd.isError && jd.data.description?.length > 200, `get_job oracle → "${jd.data.title}"`);
  const byUrl = await call("get_job", { job: jpm.data.jobs[0].url });
  ok(!byUrl.isError && byUrl.data.title === jd.data.title, "get_job oracle by URL");
}
const nv = await call("search_jobs", { company: "https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/Some-Job_JR1", keywords: "software engineer", location: "Bangalore", limit: 3 });
ok(!nv.isError && nv.data.jobs?.length > 0, `search_jobs NVIDIA from one Workday job URL → ${nv.data.board} ${nv.data.matching ?? nv.text.slice(0, 80)}`);
if (nv.data.jobs?.[0]) {
  const d = await call("get_job", { job: nv.data.jobs[0].job_ref });
  ok(!d.isError && d.data.description?.length > 200, `get_job workday → "${d.data.title}"`);
}
const sr = await call("search_jobs", { company: "ServiceNow", keywords: "engineer", limit: 3 });
ok(!sr.isError && sr.data.board?.startsWith("smartrecruiters") && sr.data.jobs?.length > 0, `search_jobs ServiceNow (smartrecruiters guess) → ${sr.data.board ?? sr.text.slice(0, 80)}`);
if (sr.data.jobs?.[0]) {
  const d = await call("get_job", { job: sr.data.jobs[0].job_ref });
  ok(!d.isError && d.data.description?.length > 200, `get_job smartrecruiters → "${d.data.title}"`);
}
const wk = await call("search_jobs", { company: "https://apply.workable.com/blueground/", limit: 3 });
ok(!wk.isError && wk.data.jobs?.length > 0, `search_jobs workable URL → ${wk.data.total_open_roles ?? wk.text.slice(0, 80)}`);
if (wk.data.jobs?.[0]) {
  const d = await call("get_job", { job: wk.data.jobs[0].url });
  ok(!d.isError && d.data.description?.length > 200, `get_job workable by URL → "${d.data.title}"`);
}
const rc = await call("search_jobs", { company: "bunq", limit: 2 });
ok(!rc.isError && rc.data.board?.startsWith("recruitee") && rc.data.jobs?.length > 0, `search_jobs bunq (recruitee guess) → ${rc.data.total_open_roles ?? rc.text.slice(0, 80)}`);
if (rc.data.jobs?.[0]) {
  const page = await call("get_job", { job: rc.data.jobs[0].url });
  ok(!page.isError && page.data.description?.length > 200, `get_job generic page reader → "${page.data.title}"`);
}
const nvName = await call("search_jobs", { company: "NVIDIA" });
ok(typeof nvName.data === "string" ? /web search/.test(nvName.data) : nvName.data.jobs?.length > 0, `search_jobs "NVIDIA" by name → ${typeof nvName.data === "string" ? "asks Claude to web-search for a board URL" : nvName.data.board}`);
const none = await call("search_jobs", { company: "zzqx-not-a-company" });
ok(typeof none.data === "string" && none.data.startsWith("No job board"), "search_jobs unknown company explains next step");

// Profile & answers
await call("update_profile", { facts: { full_name: "Test User", email: EMAIL, notice_period: "Immediate" } });
const p = await call("get_profile");
ok(p.data.full_name === "Test User", "profile saved and read");
await call("save_answer", { question: "Why do you want to work at Acme?", answer: "Because I love building reliable backend systems." });
const fa = await call("find_saved_answers", { question: "why work at this company" });
ok(Array.isArray(fa.data) && fa.data.length === 1, "saved answer found by similar question");

// Forms
const forms = await call("get_open_forms");
ok(forms.data.extension_connected === true && forms.data.forms?.[0]?.form_id === FORM.formId, "get_open_forms sees the extension's form");
const fill = await call("fill_form", {
  form_id: FORM.formId,
  answers: [
    { field_id: "f1", value: "Test" },
    { field_id: "f2", value: EMAIL },
    { field_id: "f3", value: "Because I love building reliable backend systems." },
    { field_id: "f4", value: "Immediate" },
  ],
});
ok(!fill.isError && fill.data.filled === 4 && fill.data.not_filled?.[0]?.label === "Resume/CV", "fill_form round-trip through the room to the extension");
ok(ext.fills.length === 1, "extension received exactly one fill message");
const badFill = await call("fill_form", { form_id: "nope", answers: [{ field_id: "f1", value: "x" }] });
ok(badFill.isError, "fill_form on unknown form errors");

// Tracker
const tr = await call("track_application", { company: "Acme", role: "Backend Engineer", url: FORM.url, status: "Applying" });
ok(tr.data.created === true && tr.data.application.status === "Applying", "track_application creates");
ext.ws.send(
  JSON.stringify({
    type: "submitted",
    formId: FORM.formId,
    url: FORM.url,
    answers: [{ question: "Tell us about a project you are proud of", answer: "I built a job tracker that fills forms through a browser extension and MCP." }],
  }),
);
await new Promise((r) => setTimeout(r, 500));
const list = await call("list_applications");
ok(list.data.applications?.length === 1 && list.data.applications[0].status === "Applied", "submit in browser marks the same application Applied");
const learned = await call("find_saved_answers", { question: "project proud" });
ok(Array.isArray(learned.data) && learned.data[0]?.source === "submitted", "submitted long answers are added to the answer bank");
const upd = await call("update_application", { id: list.data.applications[0].id, status: "OA", next_step: "HackerRank OA", next_step_date: "2026-10-10" });
ok(upd.data.status === "OA", "update_application");
const csv = await call("export_applications");
ok(csv.text.startsWith("Company,Role,Status") && csv.text.includes("Acme"), "export_applications CSV");
// Suggestions + multi-step advance
await call("update_profile", { facts: { full_name: "Test User", email: EMAIL, work_authorization: "yes", requires_sponsorship: "no", years_experience: "3" } });
ext.ws.send(JSON.stringify({ type: "form", form: { ...PAGE1, capturedAt: Date.now() } }));
await new Promise((r) => setTimeout(r, 300));
const mp = await call("get_open_forms", { form_id: PAGE1.formId });
const f = Object.fromEntries((mp.data.forms?.[0]?.fields ?? []).map((x) => [x.id, x]));
ok(f.a1?.suggested === "Test" && f.a2?.suggested === "User" && f.a3?.suggested === EMAIL, "suggestions: names and email from profile");
ok(f.a4?.suggested === "I decline to self-identify" && f.a5?.suggested === "Yes", "suggestions: EEO declines, work authorization → Yes");
ok(!f.a6?.suggested && mp.data.forms[0].fields_needing_your_answer === 1, "only the open-ended question is left for Claude");
const adv = await call("fill_form", { form_id: PAGE1.formId, answers: [{ field_id: "a6", value: "Because of the team." }], advance: true });
const last = ext.fills.at(-1);
ok(last.answers.length === 6 && last.advance === true, "fill_form sends suggestions + Claude's answer, with advance");
ok(adv.data.advanced === true && adv.data.next_page?.form_id === PAGE2.formId, "advance returns the next page in the same call");
const np = Object.fromEntries((adv.data.next_page?.fields ?? []).map((x) => [x.id, x]));
ok(np.q1?.suggested === "No" && np.q2?.suggested === "3", "next page arrives with its own suggestions (sponsorship → No, years → 3)");
const waiting = call("wait_for_next_page", { form_id: PAGE2.formId, timeout_seconds: 10 });
setTimeout(() => ext.ws.send(JSON.stringify({ type: "form", form: { ...PAGE2, formId: "form-e2e-p3", step: 3, capturedAt: Date.now() } })), 800);
const w = await waiting;
ok(w.data.form_id === "form-e2e-p3", "wait_for_next_page returns when the user reaches the next page");
const stale = await call("wait_for_next_page", { form_id: PAGE1.formId, timeout_seconds: 5 });
ok(stale.data.form_id === "form-e2e-p3", "wait_for_next_page on an old page id returns the current page");
ext.ws.send(JSON.stringify({ type: "form_closed", formId: "form-e2e-p3" }));

// Another user must not see this user's forms or tracker.
const otherToken = await connectorToken(`other-${Date.now()}@example.com`);
const other = new Client({ name: "e2e-other", version: "0.0.1" });
await other.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { authorization: `Bearer ${otherToken}` } } }));
ext.ws.send(JSON.stringify({ type: "form", form: { ...FORM, formId: "form-e2e-2" } }));
await new Promise((r) => setTimeout(r, 300));
const otherForms = await other.callTool({ name: "get_open_forms", arguments: {} });
const otherApps = await other.callTool({ name: "list_applications", arguments: {} });
ok(!otherForms.content[0].text.includes("form-e2e") && otherApps.content[0].text.startsWith("No tracked"), "another user sees none of this user's forms or applications");
const fillsBefore = ext.fills.length;
const stolen = await other.callTool({ name: "fill_form", arguments: { form_id: "form-e2e-2", answers: [{ field_id: "f1", value: "x" }] } });
ok(stolen.isError && ext.fills.length === fillsBefore, "another user cannot fill this user's form");
await other.close();
ext.ws.send(JSON.stringify({ type: "form_closed", formId: "form-e2e-2" }));
await new Promise((r) => setTimeout(r, 200));

const formsAfter = await call("get_open_forms");
ok(typeof formsAfter.data === "string", "submitted form is cleared from open forms");
ext.ws.send(JSON.stringify({ type: "page", page: { session: "sess-l", url: "https://stripe.com/jobs/listing/x/1", title: "Engineer", site: "generic", company: "Stripe", role: "Engineer", hasApplyButton: true, applyLink: "https://stripe.com/jobs/apply/x/1", seenAt: Date.now() } }));
await new Promise((r) => setTimeout(r, 300));
const lp = await call("get_open_forms");
ok(lp.data.job_pages_without_form?.[0]?.apply_link?.includes("/apply/") && /click Apply/.test(lp.data.hint), "listing page without a form tells Claude the user must click Apply");
ok(ext.gotPong === true, "keep-alive ping answered");

ext.ws.close();
await client.close();
console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
