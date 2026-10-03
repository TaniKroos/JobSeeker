// End-to-end test against a running `wrangler dev` (default http://localhost:8787, DEV_PASSCODE login).
// Plays both sides: an MCP client (like Claude) and the Chrome extension (WebSocket).
// Usage: node scripts/e2e.mjs [baseUrl]

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";

const BASE = process.argv[2] ?? "http://localhost:8787";
const LOCAL = /localhost|127\.0\.0\.1/.test(BASE);
const PASSCODE = process.env.DEV_PASSCODE ?? "letmein";
const EMAIL = `e2e-${Date.now()}@example.com`;
const EXT_REDIRECT = "https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/cb";
const DAY = 86_400_000;

let failures = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures++;
};
const b64url = (b) => Buffer.from(b).toString("base64url");
const cookiesFrom = (res) => res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Local D1, for checks on what is (not) stored.
function sql(query) {
  const out = execFileSync("npx", ["wrangler", "d1", "execute", "job_copilot", "--local", "--json", "--command", query], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return JSON.parse(out)[0].results;
}

// ---------- 1. Connector OAuth (what Claude does) ----------
async function connectorToken(email = EMAIL) {
  const reg = await fetch(`${BASE}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "E2E Test Client", redirect_uris: ["https://client.example.com/callback"], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
  }).then((r) => r.json());
  const verifier = b64url(crypto.randomBytes(32));
  const authUrl = new URL(`${BASE}/authorize`);
  Object.entries({ response_type: "code", client_id: reg.client_id, redirect_uri: "https://client.example.com/callback", state: "xyz", code_challenge: b64url(crypto.createHash("sha256").update(verifier).digest()), code_challenge_method: "S256", resource: `${BASE}/mcp` }).forEach(([k, v]) => authUrl.searchParams.set(k, v));
  const page = await fetch(authUrl, { redirect: "manual" });
  const html = await page.text();
  const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1];
  if (email === EMAIL) {
    ok(page.status === 200 && !!handle, "consent page renders");
    ok(html.includes("E2E Test Client"), "consent page names the client");
  }
  const post = await fetch(`${BASE}/authorize`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookiesFrom(page) }, body: new URLSearchParams({ handle, method: "dev", email, passcode: PASSCODE }) });
  const loc = new URL(post.headers.get("location") ?? "about:blank");
  const code = loc.searchParams.get("code");
  const tok = await fetch(`${BASE}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: "https://client.example.com/callback", client_id: reg.client_id, code_verifier: verifier, resource: `${BASE}/mcp` }) }).then((r) => r.json());
  if (email === EMAIL) ok(!!tok.access_token, "connector sign-in and token exchange");
  return tok.access_token;
}

// ---------- 2. Extension sign-in + WebSocket ticket ----------
async function extensionToken() {
  const page = await fetch(`${BASE}/ext/login?redirect_uri=${encodeURIComponent(EXT_REDIRECT)}`);
  const csrf = /name="csrf" value="([^"]+)"/.exec(await page.text())?.[1];
  const bad = await fetch(`${BASE}/ext/login?redirect_uri=${encodeURIComponent("https://evil.example.com/")}`);
  ok(bad.status === 400, "extension login rejects non-extension redirects");
  const post = await fetch(`${BASE}/ext/login`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookiesFrom(page) }, body: new URLSearchParams({ csrf, method: "dev", email: EMAIL, passcode: PASSCODE }) });
  const hash = new URLSearchParams((post.headers.get("location") ?? "").split("#")[1] ?? "");
  ok(!!hash.get("token"), "extension receives its token");
  return hash.get("token");
}

async function wsTicket(token) {
  const r = await fetch(`${BASE}/ext/ws-ticket`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
  return r.ok ? (await r.json()).ticket : null;
}

function openWs(query) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/ext/ws?${query}`);
    ws.onopen = () => resolve(ws);
    ws.onerror = () => resolve(null);
  });
}

// ---------- 3. Fake extension ----------
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
    { id: "f4", label: "Will you require visa sponsorship?", kind: "select", required: true, options: ["Yes", "No"] },
    { id: "f5", label: "Gender", kind: "select", required: false, options: ["Male", "Female", "I decline to self-identify"] },
    { id: "f6", label: "Resume/CV", kind: "file", required: true },
  ],
};
const WD1 = {
  formId: "wd-p1",
  session: "sess-wd",
  step: 1,
  url: "https://acme.wd1.myworkdayjobs.com/en-US/Careers/job/X/apply",
  site: "workday",
  company: "Acme",
  role: "Data Engineer",
  pageTitle: "My Information",
  capturedAt: Date.now(),
  fields: [
    { id: "a1", label: "Legal Name", kind: "text", required: true },
    { id: "a2", label: "Email Address", kind: "text", inputType: "email", required: true },
  ],
};
const WD2 = { ...WD1, formId: "wd-p2", step: 2, url: WD1.url + "/step2", pageTitle: "Application Questions", fields: [{ id: "q1", label: "Are you legally authorized to work in India?", kind: "select", required: true, options: ["Yes", "No"] }] };

function connectExtension(ticket) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/ext/ws?ticket=${encodeURIComponent(ticket)}`);
    const state = { ws, fills: [], blockNext: false };
    ws.onerror = (e) => reject(e);
    ws.onmessage = (ev) => {
      if (ev.data === "pong") return void (state.gotPong = true);
      const msg = JSON.parse(ev.data);
      if (msg.type === "hello") {
        ws.send(JSON.stringify({ type: "form", form: FORM }));
        setTimeout(() => resolve(state), 300);
      }
      if (msg.type === "fill") {
        state.fills.push(msg);
        const form = [FORM, WD1, WD2].find((f) => f.formId === msg.formId) ?? { fields: [] };
        const results = form.fields.map((f) => {
          const a = msg.answers.find((x) => x.fieldId === f.id);
          if (f.kind === "file") return { fieldId: f.id, label: f.label, status: "needs_user", note: "Upload this file yourself" };
          return { fieldId: f.id, label: f.label, status: a ? "filled" : "skipped" };
        });
        if (!msg.advance) return ws.send(JSON.stringify({ type: "fill_result", requestId: msg.requestId, formId: msg.formId, results }));
        if (state.blockNext) {
          ws.send(JSON.stringify({ type: "fill_result", requestId: msg.requestId, formId: msg.formId, results, advance: { clicked: true, button: "Next" } }));
          setTimeout(() => ws.send(JSON.stringify({ type: "advance_blocked", formId: msg.formId, note: 'Clicked "Next" but the page didn\'t advance; it flags: Employee ID.' })), 300);
          return;
        }
        ws.send(JSON.stringify({ type: "fill_result", requestId: msg.requestId, formId: msg.formId, results, advance: { clicked: true, button: "Save and Continue" } }));
        if (msg.formId === WD1.formId) setTimeout(() => ws.send(JSON.stringify({ type: "form", form: { ...WD2, capturedAt: Date.now() } })), 400);
      }
    };
  });
}

// ---------- run ----------
const accessToken = await connectorToken();
const extToken = await extensionToken();

ok((await openWs(`token=${encodeURIComponent(extToken)}`)) === null, "WebSocket no longer accepts the raw token in the URL");
ok((await openWs("ticket=forged.ticket")) === null, "WebSocket rejects a forged ticket");
const ticket = await wsTicket(extToken);
ok(!!ticket && (await wsTicket("nope")) === null, "ticket endpoint: issues for a valid token, refuses a bad one");
const ext = await connectExtension(ticket);
ext.ws.send("ping");

const client = new Client({ name: "e2e", version: "0.0.1" });
await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { authorization: `Bearer ${accessToken}` } } }));
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const t = r.content?.[0]?.text ?? "";
  let data;
  try {
    data = JSON.parse(t);
  } catch {
    data = t;
  }
  return { isError: !!r.isError, data, text: t };
};

const tools = (await client.listTools()).tools.map((t) => t.name).sort();
const expected = ["delete_application", "delete_my_data", "export_applications", "fill_form", "get_job", "get_open_forms", "list_applications", "search_jobs", "track_application", "update_application", "wait_for_next_page"];
ok(JSON.stringify(tools) === JSON.stringify(expected), `11 tools, no profile/answer tools (${tools.join(", ")})`);

// ---------- job search: recency, paging, boards ----------
const sorted = (jobs) => jobs.every((j, i) => i === 0 || (jobs[i - 1].posted ?? "").replace("before ", "") >= (j.posted ?? "").replace("before ", ""));
const s = await call("search_jobs", { company: "stripe", keywords: "engineer", limit: 5, posted_within_days: 0 });
ok(!s.isError && s.data.jobs?.length === 5 && sorted(s.data.jobs), `Greenhouse (Stripe): newest first, ${s.data.matching} matching`);
const s2 = await call("search_jobs", { company: "stripe", keywords: "engineer", limit: 5, offset: 5, posted_within_days: 0 });
ok(s2.data.offset === 5 && s2.data.jobs?.[0]?.job_ref !== s.data.jobs?.[0]?.job_ref && s.data.next_offset === 5, "offset returns the next page (next_offset given)");
const recent = await call("search_jobs", { company: "stripe", keywords: "engineer", limit: 50, posted_within_days: 30 });
const cutoff = new Date(Date.now() - 30 * DAY).toISOString().slice(0, 10);
ok(!recent.isError && (recent.data.jobs ?? []).every((j) => !j.posted || j.posted >= cutoff), `posted_within_days 30 drops older jobs (${recent.data.older_hidden ?? 0} hidden)`);
const gj = await call("get_job", { job: s.data.jobs?.[0]?.job_ref });
ok(!gj.isError && gj.data.description?.length > 100, `get_job greenhouse → "${gj.data.title}"`);
const lever = await call("search_jobs", { company: "https://jobs.lever.co/palantir", limit: 3, posted_within_days: 0 });
ok(lever.data.jobs?.length === 3 && sorted(lever.data.jobs), `Lever: ${lever.data.total_on_board} on board, newest first`);
const ashby = await call("search_jobs", { company: "ramp", limit: 3, posted_within_days: 0 });
ok(ashby.data.jobs?.length > 0 && sorted(ashby.data.jobs), `Ashby (Ramp): ${ashby.data.total_on_board} on board`);
const jpm = await call("search_jobs", { company: "https://www.jpmorganchase.com/careers", keywords: "software engineer", location: "Bangalore", limit: 3 });
ok(!jpm.isError && jpm.data.jobs?.length > 0 && jpm.data.jobs.every((j) => /Bengaluru/.test(j.location)) && sorted(jpm.data.jobs), `Oracle (JPMorgan careers page detected) Bangalore → ${jpm.data.matching}`);
if (jpm.data.jobs?.[0]) ok(!(await call("get_job", { job: jpm.data.jobs[0].job_ref })).isError, "get_job oracle");
const nv = await call("search_jobs", { company: "https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/X_JR1", keywords: "software engineer", location: "Bangalore", limit: 5, posted_within_days: 0 });
ok(!nv.isError && nv.data.jobs?.length > 0 && nv.data.jobs.every((j) => /Bengaluru|Locations/.test(j.location)) && sorted(nv.data.jobs), `Workday (NVIDIA) location filtered on Workday's side: ${nv.data.total_on_board} in Bengaluru`);
if (nv.data.jobs?.[0]) ok(!(await call("get_job", { job: nv.data.jobs[0].job_ref })).isError, "get_job workday");
const sr = await call("search_jobs", { company: "ServiceNow", keywords: "engineer", limit: 3, posted_within_days: 0 });
ok(sr.data.board?.startsWith("smartrecruiters") && sr.data.jobs?.length > 0 && sorted(sr.data.jobs), `SmartRecruiters (name guess) → ${sr.data.total_on_board}`);
const wk = await call("search_jobs", { company: "https://apply.workable.com/blueground/", limit: 3, posted_within_days: 0 });
ok(wk.data.jobs?.length > 0, `Workable → ${wk.data.total_on_board}`);
const rc = await call("search_jobs", { company: "bunq", limit: 2, posted_within_days: 0 });
ok(rc.data.board?.startsWith("recruitee") && rc.data.jobs?.length > 0, `Recruitee (name guess) → ${rc.data.total_on_board}`);
if (rc.data.jobs?.[0]) ok((await call("get_job", { job: rc.data.jobs[0].url })).data.description?.length > 200, "get_job reads a generic job page");
const none = await call("search_jobs", { company: "zzqx-not-a-company" });
ok(typeof none.data === "string" && /web search/.test(none.data), "unknown company: tells Claude what to web-search");

// ---------- forms: facts (never stored), suggestions, fill ----------
const FACTS = { full_name: "Asha Rao", email: "asha@example.com", requires_sponsorship: "no", work_authorization: "yes" };
const forms = await call("get_open_forms", { facts: FACTS });
const f = Object.fromEntries((forms.data.forms?.[0]?.fields ?? []).map((x) => [x.id, x]));
ok(forms.data.extension_connected && forms.data.forms?.[0]?.form_id === FORM.formId, "get_open_forms sees the extension's form");
ok(f.f1?.suggested === "Asha" && f.f2?.suggested === "asha@example.com" && f.f4?.suggested === "No" && f.f5?.suggested === "I decline to self-identify", "suggestions from facts (name, email, sponsorship) and EEO decline");
ok(!f.f3?.suggested && forms.data.forms[0].fields_needing_your_answer === 1, "only the open question is left for Claude");
const noFacts = await call("get_open_forms");
ok(!noFacts.data.forms?.[0]?.fields.find((x) => x.id === "f1")?.suggested, "facts are not remembered between calls");
const fill = await call("fill_form", { form_id: FORM.formId, facts: FACTS, answers: [{ field_id: "f3", value: "Because I love reliable systems." }] });
ok(!fill.isError && fill.data.filled === 5 && fill.data.not_filled?.[0]?.label === "Resume/CV" && fill.data.advanced === undefined, "fill: suggestions + 1 answer; single-page form doesn't auto-advance");
ok(ext.fills.at(-1).answers.length === 5, "extension received 5 answers");

// ---------- multi-step: automatic advance without Claude asking ----------
ext.ws.send(JSON.stringify({ type: "form", form: { ...WD1, capturedAt: Date.now() } }));
await sleep(300);
const wd = await call("get_open_forms", { form_id: WD1.formId, facts: FACTS });
ok(wd.data.forms?.[0]?.multi_step === true && /don't ask the user to click Next/.test(wd.data.forms[0].multi_step_note), "Workday form flagged multi_step with a 'don't ask the user' note");
const adv = await call("fill_form", { form_id: WD1.formId, facts: FACTS });
ok(ext.fills.at(-1).advance === true, "advance defaults to true on Workday (Claude didn't pass it)");
ok(adv.data.advanced === true && adv.data.next_page?.form_id === WD2.formId && adv.data.next_page.fields[0].suggested === "Yes", "next page returned in the same call, with suggestions");
const waiting = call("wait_for_next_page", { form_id: WD2.formId, timeout_seconds: 10 });
setTimeout(() => ext.ws.send(JSON.stringify({ type: "form", form: { ...WD2, formId: "wd-p3", step: 3, capturedAt: Date.now() } })), 600);
ok((await waiting).data.form_id === "wd-p3", "wait_for_next_page returns when the next page appears");
ok((await call("wait_for_next_page", { form_id: WD1.formId, timeout_seconds: 5 })).data.form_id === "wd-p3", "an old page id follows to the current page");
ext.blockNext = true;
const blocked = await call("fill_form", { form_id: "wd-p3", facts: FACTS });
ok(blocked.data.advanced === false && /Employee ID/.test(blocked.data.advance_note ?? ""), `a refused Next is reported: ${blocked.data.advance_note}`);
ext.blockNext = false;
const manual = await call("fill_form", { form_id: "wd-p3", facts: FACTS, advance: false });
ok(ext.fills.at(-1).advance === false && manual.data.advanced === undefined, "advance=false is respected");
ext.ws.send(JSON.stringify({ type: "form_closed", formId: "wd-p3" }));

// ---------- tracker: minimal fields, 90-day retention ----------
const tr = await call("track_application", { company: "Acme", role: "Backend Engineer", url: FORM.url, status: "Applying" });
ok(tr.data.created && tr.data.application.status === "Applying" && !("notes" in tr.data.application) && tr.data.application.kept_until, "track_application keeps only company/role/url/status (+ kept_until)");
ext.ws.send(JSON.stringify({ type: "submitted", formId: FORM.formId, url: FORM.url }));
await sleep(500);
const list = await call("list_applications");
ok(list.data.applications?.length === 1 && list.data.applications[0].status === "Applied" && list.data.applications[0].applied_on, "submit marks the same application Applied with a date");
const upd = await call("update_application", { id: list.data.applications[0].id, status: "OA" });
ok(upd.data.status === "OA", "update_application");
const csv = await call("export_applications");
ok(csv.text.startsWith("Company,Role,Status,Applied on,URL,Last updated") && csv.text.includes("Acme"), "CSV export (minimal columns)");
if (LOCAL) {
  await call("track_application", { company: "Oldco", role: "Engineer", status: "Applied" });
  sql(`UPDATE applications SET updated_at = ${Date.now() - 91 * DAY} WHERE company = 'Oldco'`);
  const l2 = await call("list_applications");
  ok(!l2.data.applications.some((a) => a.company === "Oldco"), "applications older than 90 days are hidden");
  const tables = sql("SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name);
  const cols = sql("PRAGMA table_info(applications)").map((r) => r.name);
  ok(!tables.includes("profiles") && !tables.includes("answers") && !cols.includes("notes") && !cols.includes("next_step"), `no profile/answers tables; applications columns: ${cols.join(", ")}`);
}

// ---------- isolation ----------
const otherToken = await connectorToken(`other-${Date.now()}@example.com`);
const other = new Client({ name: "e2e-other", version: "0.0.1" });
await other.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { authorization: `Bearer ${otherToken}` } } }));
ext.ws.send(JSON.stringify({ type: "form", form: { ...FORM, formId: "form-e2e-2", session: "s2" } }));
await sleep(300);
const otherForms = await other.callTool({ name: "get_open_forms", arguments: {} });
const otherApps = await other.callTool({ name: "list_applications", arguments: {} });
ok(!otherForms.content[0].text.includes("form-e2e") && otherApps.content[0].text.startsWith("No tracked"), "another user sees none of this user's forms or applications");
const fillsBefore = ext.fills.length;
const stolen = await other.callTool({ name: "fill_form", arguments: { form_id: "form-e2e-2", answers: [{ field_id: "f1", value: "x" }] } });
ok(stolen.isError && ext.fills.length === fillsBefore, "another user cannot fill this user's form");
await other.close();
ext.ws.send(JSON.stringify({ type: "form_closed", formId: "form-e2e-2" }));
await sleep(200);

// ---------- job page without a form ----------
ext.ws.send(JSON.stringify({ type: "page", page: { session: "sess-l", url: "https://jobs.lever.co/x/1", title: "Engineer", site: "lever", company: "X", role: "Engineer", hasApplyButton: true, applyLink: "https://jobs.lever.co/x/1/apply", seenAt: Date.now() } }));
await sleep(300);
const lp = await call("get_open_forms");
ok(lp.data.job_pages_without_form?.[0]?.apply_link?.endsWith("/apply") && /click Apply/.test(lp.data.hint), "a job page without a form tells Claude the user must click Apply");
ok(ext.gotPong === true, "keep-alive ping answered");

// ---------- delete my data ----------
const del = await call("delete_my_data", { confirm: true });
ok(!del.isError && (await call("list_applications")).text.startsWith("No tracked"), "delete_my_data erases the tracker");
ok((await wsTicket(extToken)) === null, "...and signs the extension out");

ext.ws.close();
await client.close();
console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
