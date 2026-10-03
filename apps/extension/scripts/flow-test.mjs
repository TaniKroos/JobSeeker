// Browser test for multi-page forms, job pages without a form, and "any website" mode.
// Fake pages are served by Playwright at real job-site URLs, so nothing leaves the machine.
// Prereqs: `wrangler dev` (DEV_PASSCODE login) and a fresh `wxt build`.
// Usage: node scripts/flow-test.mjs [baseUrl]

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { chromium } from "playwright";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = process.argv[2] ?? "http://localhost:8787";
const PASSCODE = process.env.DEV_PASSCODE ?? "letmein";
const EMAIL = `flow-${Date.now()}@example.com`;
const EXT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.output/chrome-mv3");
const b64url = (b) => Buffer.from(b).toString("base64url");
const cookiesFrom = (res) => res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
let failures = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures++;
};

async function connectorToken() {
  const redirect = "https://client.example.com/callback";
  const reg = await fetch(`${BASE}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Flow test", redirect_uris: [redirect], token_endpoint_auth_method: "none" }) }).then((r) => r.json());
  const verifier = b64url(crypto.randomBytes(32));
  const u = new URL(`${BASE}/authorize`);
  Object.entries({ response_type: "code", client_id: reg.client_id, redirect_uri: redirect, state: "s", code_challenge: b64url(crypto.createHash("sha256").update(verifier).digest()), code_challenge_method: "S256", resource: `${BASE}/mcp` }).forEach(([k, v]) => u.searchParams.set(k, v));
  const page = await fetch(u);
  const handle = /name="handle" value="([^"]+)"/.exec(await page.text())[1];
  const post = await fetch(`${BASE}/authorize`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookiesFrom(page) }, body: new URLSearchParams({ handle, method: "dev", email: EMAIL, passcode: PASSCODE }) });
  const code = new URL(post.headers.get("location")).searchParams.get("code");
  return (await fetch(`${BASE}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirect, client_id: reg.client_id, code_verifier: verifier, resource: `${BASE}/mcp` }) }).then((r) => r.json())).access_token;
}

async function extensionToken(extId) {
  const redirect = `https://${extId}.chromiumapp.org/cb`;
  const page = await fetch(`${BASE}/ext/login?redirect_uri=${encodeURIComponent(redirect)}`);
  const csrf = /name="csrf" value="([^"]+)"/.exec(await page.text())[1];
  const post = await fetch(`${BASE}/ext/login`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookiesFrom(page) }, body: new URLSearchParams({ csrf, method: "dev", email: EMAIL, passcode: PASSCODE }) });
  return new URLSearchParams(post.headers.get("location").split("#")[1]).get("token");
}

const parse = (r) => {
  const t = r.content?.[0]?.text ?? "";
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
};

// ---------- fixtures ----------

// Two-step SPA form (Workday-like): page 1 → "Save and Continue" swaps in page 2 at a new URL.
const WD = "https://acme.wd1.myworkdayjobs.com/en-US/Careers/job/Bangalore/Backend-Engineer_JR1/apply";
const WD_HTML = `<!doctype html><title>Backend Engineer at Acme</title><h1>Backend Engineer</h1><div id="app"></div>
<script>
const app = document.getElementById("app");
function page1() {
  app.innerHTML = '<form onsubmit="return false"><label for="fn">First Name *</label><input id="fn" required>' +
    '<label for="ln">Last Name *</label><input id="ln" required>' +
    '<label for="em">Email *</label><input id="em" type="email" required>' +
    '<label for="au">Are you legally authorized to work in India? *</label><select id="au" required><option value="">Select</option><option>Yes</option><option>No</option></select>' +
    '<button type="button" id="next">Save and Continue</button></form>';
  document.getElementById("next").onclick = () => {
    for (const id of ["fn", "ln", "em"]) if (!document.getElementById(id).value) { document.getElementById(id).setAttribute("aria-invalid", "true"); return; }
    history.pushState({}, "", location.pathname + "/step2"); page2();
  };
}
function page2() {
  app.innerHTML = '<form onsubmit="return false"><label for="sp">Will you require visa sponsorship? *</label><select id="sp" required><option value="">Select</option><option>Yes</option><option>No</option></select>' +
    '<label for="why">Why do you want to join Acme? *</label><textarea id="why" required></textarea>' +
    '<button type="button" id="back">Back</button><button type="submit">Submit</button></form>';
}
page1();
</script>`;

// A page whose Next is always rejected by validation.
const BLOCK = "https://blockco.wd1.myworkdayjobs.com/en-US/Careers/job/X/apply";
const BLOCK_HTML = `<!doctype html><title>Job Application for Engineer at BlockCo</title><form onsubmit="return false">
<label for="a">Full name *</label><input id="a" required>
<label for="b">Employee ID</label><input id="b">
<button type="button" onclick="document.getElementById('b').setAttribute('aria-invalid','true')">Next</button></form>`;

// Job description page with an Apply button, on a known site (Lever).
const LISTING = "https://jobs.lever.co/listingco/abc-123";
const LISTING_HTML = `<!doctype html><title>ListingCo - Platform Engineer</title><h2>Platform Engineer</h2><p>${"About the role. ".repeat(40)}</p>
<a class="postings-btn" href="https://jobs.lever.co/listingco/abc-123/apply">Apply for this job</a>`;

// Unknown career site, for "any website" mode.
const ANY = "http://localhost:9911/careers/apply/42";
const ANY_HTML = `<!doctype html><title>Apply · Some Startup</title><h1>Software Engineer</h1><form>
<label for="n">Your name</label><input id="n" name="name"><label for="e">Email address</label><input id="e" name="email" type="email">
<label for="w">Why us?</label><textarea id="w" name="why"></textarea><button type="submit">Submit application</button></form>`;

// ---------- run ----------

const context = await chromium.launchPersistentContext("", {
  channel: "chromium",
  headless: true,
  viewport: { width: 1280, height: 900 },
  args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`],
});
const html = (body) => (route) => route.fulfill({ contentType: "text/html", body });
await context.route(/acme\.wd1\.myworkdayjobs\.com/, html(WD_HTML));
await context.route(/blockco\.wd1\.myworkdayjobs\.com/, html(BLOCK_HTML));
await context.route(LISTING, html(LISTING_HTML));
await context.route(`${LISTING}/apply`, html(`<title>ListingCo - Platform Engineer</title><form><label for="n">Full name *</label><input id="n" required><label for="e">Email *</label><input id="e" type="email" required></form>`));
await context.route(ANY, html(ANY_HTML));

let [sw] = context.serviceWorkers();
sw ??= await context.waitForEvent("serviceworker");
const extId = sw.url().split("/")[2];
const [accessToken, extToken] = await Promise.all([connectorToken(), extensionToken(extId)]);
await sw.evaluate(([token, email, server]) => chrome.storage.local.set({ token, email, server }), [extToken, EMAIL, BASE]);
const client = new Client({ name: "flow-test", version: "0.0.1" });
await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { authorization: `Bearer ${accessToken}` } } }));
const call = async (name, args = {}) => parse(await client.callTool({ name, arguments: args }));
await call("update_profile", { facts: { full_name: "Asha Rao", email: "asha@example.com", work_authorization: "yes", requires_sponsorship: "no" } });

async function waitForForm(match, tries = 30) {
  for (let i = 0; i < tries; i++) {
    const r = await call("get_open_forms");
    const f = r.forms?.find(match);
    if (f) return { form: f, all: r };
    await new Promise((res) => setTimeout(res, 500));
  }
  return { form: null, all: await call("get_open_forms") };
}

// 1. Multi-step with advance
console.log("\n== multi-step form (advance)");
const p = await context.newPage();
await p.goto(WD);
const { form: p1 } = await waitForForm((f) => f.url === WD);
ok(!!p1 && p1.fields_needing_your_answer === 0, `page 1 captured, everything suggested from the profile (${p1?.fields.map((f) => `${f.label}=${f.suggested ?? "?"}`).join("; ")})`);
let t0 = Date.now();
const r1 = p1 ? await call("fill_form", { form_id: p1.form_id, advance: true }) : {};
ok(r1.filled === 4 && r1.advanced === true && r1.clicked_button === "Save and Continue", `fill + click "Save and Continue" (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
ok(r1.next_page?.page_step === 2 && r1.next_page.fields.length === 2, `next page returned in the same call (step ${r1.next_page?.page_step})`);
const sp = r1.next_page?.fields.find((f) => /sponsorship/i.test(f.label));
const why = r1.next_page?.fields.find((f) => /why/i.test(f.label));
ok(sp?.suggested === "No" && !why?.suggested, "page 2: sponsorship suggested No, the open question is left for Claude");
t0 = Date.now();
const r2 = r1.next_page ? await call("fill_form", { form_id: r1.next_page.form_id, answers: [{ field_id: why.id, value: "I like building reliable systems." }], advance: true }) : {};
ok(r2.filled === 2 && r2.advanced === false && /No Next\/Continue/.test(r2.advance_note ?? ""), `last page filled; it does not click Submit (${((Date.now() - t0) / 1000).toFixed(1)}s): ${r2.advance_note}`);
ok((await p.inputValue("#why")) === "I like building reliable systems.", "page 2 answer is on the page");
await p.close();

// 2. Next rejected by validation
console.log("\n== Next blocked by validation");
const b = await context.newPage();
await b.goto(BLOCK);
const { form: bf } = await waitForForm((f) => f.url === BLOCK);
const rb = bf ? await call("fill_form", { form_id: bf.form_id, advance: true }) : {};
ok(rb.advanced === false && /didn't advance/.test(rb.advance_note ?? ""), `blocked page reported: ${rb.advance_note}`);
await b.close();

// 3. Job description page → Apply
console.log("\n== job page without a form");
const l = await context.newPage();
await l.goto(LISTING);
let lp;
for (let i = 0; i < 20 && !lp?.job_pages_without_form?.length; i++) {
  await l.waitForTimeout(500);
  lp = await call("get_open_forms");
}
const jp = lp?.job_pages_without_form?.find((x) => x.url === LISTING);
ok(!!jp && jp.has_apply_button && jp.apply_link?.endsWith("/apply"), `Claude sees the job page and its apply link (${jp?.apply_link})`);
await l.click("a.postings-btn");
const { form: af } = await waitForForm((f) => f.url === `${LISTING}/apply`);
ok(!!af, "after Apply, the form is captured");
const after = await call("get_open_forms");
ok(!after.job_pages_without_form?.some((x) => x.url === LISTING), "the job page entry is replaced by the form");
await l.close();

// 4. Any website ("lazy" mode script, injected the way the all-sites registration runs it)
console.log("\n== any website mode");
const a = await context.newPage();
await a.goto(ANY);
const tab = await sw.evaluate(async (url) => (await chrome.tabs.query({ url: url + "*" }))[0]?.id, "http://localhost:9911/careers");
await sw.evaluate((id) => chrome.scripting.executeScript({ target: { tabId: id, allFrames: true }, files: ["/auto.js"] }), tab);
const { form: anyf } = await waitForForm((f) => f.url === ANY);
ok(!!anyf && anyf.fields.length === 3, `unknown career site captured (${anyf?.fields.map((f) => f.label).join(", ")})`);
const ra = anyf ? await call("fill_form", { form_id: anyf.form_id, answers: [{ field_id: anyf.fields[2].id, value: "Mission." }] }) : {};
ok(ra.filled === 3, `filled with suggestions + 1 answer (${ra.filled})`);
await a.close();

await client.close();
await context.close();
console.log(failures ? `\n${failures} check(s) failed` : "\nAll flow checks passed");
process.exit(failures ? 1 : 0);
