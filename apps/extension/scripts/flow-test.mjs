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

// Five-page Workday-style application with Workday widgets: listbox buttons, a searchable
// multi-select prompt, a required resume upload, and a Review page with only Submit.
const WD5 = "https://flowco.wd3.myworkdayjobs.com/en-US/External/job/Bengaluru/Engineer_JR9/apply";
const WD5_HTML = `<!doctype html><title>Engineer</title><h2 id="pt"></h2><div id="app"></div>
<script>
const app = document.getElementById("app"); let step = 0;
const pages = [
  ["My Information", '<label id="ln">Legal Name *</label><input aria-labelledby="ln" required>' +
    '<label id="em">Email Address *</label><input type="email" aria-labelledby="em" required>' +
    '<div><label id="cl">Country *</label><button type="button" aria-haspopup="listbox" aria-labelledby="cl" data-opts="United States,India,Canada">Select One</button></div>' +
    '<div><label id="hh">How Did You Hear About Us? *</label><div data-automation-id="multiselectInputContainer"><input placeholder="Search" aria-labelledby="hh" data-src="LinkedIn,Company Website,Referral"></div><div class="chips"></div></div>'],
  ["My Experience", '<label for="cv">Resume/CV *</label><input id="cv" type="file" required>' +
    '<label for="sk">Skills</label><input id="sk">'],
  ["Application Questions", '<div><label id="sp">Will you now or in the future require visa sponsorship? *</label><button type="button" aria-haspopup="listbox" aria-labelledby="sp" data-opts="Yes,No">Select One</button></div>' +
    '<label for="np">Notice period</label><input id="np">'],
  ["Voluntary Disclosures", '<div><label id="gd">Gender</label><button type="button" aria-haspopup="listbox" aria-labelledby="gd" data-opts="Male,Female,I do not wish to answer">Select One</button></div>' +
    '<div><label id="vt">Veteran Status</label><button type="button" aria-haspopup="listbox" aria-labelledby="vt" data-opts="I am a veteran,I am not a veteran,I do not wish to self-identify">Select One</button></div>'],
  ["Review", '<p>Review your application.</p>'],
];
function render() {
  const [title, body] = pages[step];
  document.getElementById("pt").textContent = title;
  const nav = step < 4 ? '<button type="button" id="next">Save and Continue</button>' : '<button type="button" id="submit">Submit</button>';
  app.innerHTML = '<div>' + body + '</div><div>' + (step ? '<button type="button" id="back">Back</button>' : '') + nav + '</div>';
  app.querySelectorAll("button[aria-haspopup=listbox]").forEach((b) => b.onclick = () => {
    document.querySelectorAll("[role=listbox]").forEach((l) => l.remove());
    const ul = document.createElement("ul"); ul.setAttribute("role", "listbox");
    for (const o of b.dataset.opts.split(",")) { const li = document.createElement("li"); li.setAttribute("role", "option"); li.textContent = o; li.onclick = () => { b.textContent = o; (window.__picked ??= {})[b.getAttribute("aria-labelledby")] = o; ul.remove(); }; ul.appendChild(li); }
    document.body.appendChild(ul);
  });
  app.querySelectorAll("[data-src]").forEach((inp) => inp.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    document.querySelectorAll("[data-automation-id=promptOption]").forEach((x) => x.remove());
    for (const o of inp.dataset.src.split(",").filter((o) => o.toLowerCase().includes(inp.value.toLowerCase()))) {
      const d = document.createElement("div"); d.setAttribute("data-automation-id", "promptOption"); d.textContent = o;
      d.onclick = () => { inp.closest("div").parentElement.querySelector(".chips").textContent = o; (window.__picked ??= {}).hh = o; inp.value = ""; inp.dataset.done = "1"; d.remove(); };
      document.body.appendChild(d);
    }
  }));
  const next = document.getElementById("next");
  if (next) next.onclick = () => {
    const missing = [...app.querySelectorAll("input[required]")].filter((i) => i.type === "file" ? !i.files.length : !(i.value || i.dataset.done));
    const unpicked = [...app.querySelectorAll("button[aria-haspopup]")].filter((b) => b.textContent === "Select One" && document.getElementById(b.getAttribute("aria-labelledby")).textContent.includes("*"));
    if (missing.length || unpicked.length) { [...missing, ...unpicked].forEach((x) => x.setAttribute("aria-invalid", "true")); return; }
    step++; history.pushState({}, "", location.pathname.split("/step")[0] + "/step" + step); render();
  };
}
render();
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
await context.route(/flowco\.wd3\.myworkdayjobs\.com/, html(WD5_HTML));
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
// Facts come from the assistant's memory with each call; nothing is stored on the server.
const FACTS = { full_name: "Asha Rao", email: "asha@example.com", work_authorization: "yes", requires_sponsorship: "no", country: "India" };

async function waitForForm(match, tries = 30) {
  for (let i = 0; i < tries; i++) {
    const r = await call("get_open_forms", { facts: FACTS });
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
const r1 = p1 ? await call("fill_form", { form_id: p1.form_id, facts: FACTS, advance: true }) : {};
ok(r1.filled === 4 && r1.advanced === true && r1.clicked_button === "Save and Continue", `fill + click "Save and Continue" (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
ok(r1.next_page?.page_step === 2 && r1.next_page.fields.length === 2, `next page returned in the same call (step ${r1.next_page?.page_step})`);
const sp = r1.next_page?.fields.find((f) => /sponsorship/i.test(f.label));
const why = r1.next_page?.fields.find((f) => /why/i.test(f.label));
ok(sp?.suggested === "No" && !why?.suggested, "page 2: sponsorship suggested No, the open question is left for Claude");
t0 = Date.now();
const r2 = r1.next_page ? await call("fill_form", { form_id: r1.next_page.form_id, facts: FACTS, answers: [{ field_id: why.id, value: "I like building reliable systems." }], advance: true }) : {};
ok(r2.filled === 2 && r2.advanced === false && /No Next\/Continue/.test(r2.advance_note ?? ""), `last page filled; it does not click Submit (${((Date.now() - t0) / 1000).toFixed(1)}s): ${r2.advance_note}`);
ok((await p.inputValue("#why")) === "I like building reliable systems.", "page 2 answer is on the page");
await p.close();

// 1b. Five-page Workday flow; Claude never passes `advance`
console.log("\n== 5-page Workday flow (no advance parameter, required resume, Review page)");
const w5 = await context.newPage();
await w5.goto(WD5);
const { form: m1 } = await waitForForm((f) => f.url === WD5);
const m1f = Object.fromEntries((m1?.fields ?? []).map((f) => [f.label, f]));
ok(!!m1 && m1.multi_step && m1f["Country"]?.kind === "select" && m1f["Country"]?.suggested === "India", `My Information captured incl. Workday listbox (Country → ${m1f["Country"]?.suggested}) and prompt`);
t0 = Date.now();
const s1 = m1 ? await call("fill_form", { form_id: m1.form_id, facts: FACTS, answers: [{ field_id: m1f["How Did You Hear About Us?"].id, value: "LinkedIn" }] }) : {};
ok(s1.filled === 4 && s1.advanced === true && s1.next_page?.page_step === 2, `page 1 filled (${s1.filled}) and moved on by itself → step ${s1.next_page?.page_step} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
const picked1 = await w5.evaluate(() => window.__picked ?? {});
ok(picked1.hh === "LinkedIn" && picked1.cl === "India", `Workday widgets really set on page 1 (${JSON.stringify(picked1)})`);
const s2r = s1.next_page ? await call("fill_form", { form_id: s1.next_page.form_id, facts: FACTS }) : {};
ok(s2r.advanced === false && /Resume\/CV/.test(s2r.advance_note ?? ""), `required resume blocks it: "${(s2r.advance_note ?? "").slice(0, 70)}…"`);
const waitNext = call("wait_for_next_page", { form_id: s1.next_page?.form_id, facts: FACTS, timeout_seconds: 30 });
await w5.waitForTimeout(500);
await w5.setInputFiles("#cv", { name: "resume.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 test") });
const m3 = await waitNext;
ok(m3.page_step === 3 && /Application Questions/.test(await w5.textContent("#pt")), "after the user uploads the resume, the extension continues by itself (step 3)");
const s3 = m3.form_id ? await call("fill_form", { form_id: m3.form_id, facts: FACTS }) : {};
ok(s3.advanced === true && s3.next_page?.page_step === 4, `Application Questions: sponsorship → No from facts, moved on (step ${s3.next_page?.page_step})`);
const s4 = s3.next_page ? await call("fill_form", { form_id: s3.next_page.form_id, facts: FACTS }) : {};
ok(s4.filled === 2 && s4.next_page?.final_review_page === true, "Voluntary Disclosures: EEO declined, then the Review page is reported as final");
const picked4 = await w5.evaluate(() => window.__picked ?? {});
ok(picked4.gd === "I do not wish to answer" && picked4.vt === "I do not wish to self-identify" && picked4.sp === "No", `answers really set on later pages (${JSON.stringify({ sp: picked4.sp, gd: picked4.gd, vt: picked4.vt })})`);
const fin = s4.next_page ? await call("fill_form", { form_id: s4.next_page.form_id }) : {};
ok(typeof fin === "string" && /click Submit/.test(fin) && (await w5.isVisible("#submit")), "Review page: nothing filled, nothing submitted; the user clicks Submit");
await w5.close();

// 2. Next rejected by validation
console.log("\n== Next blocked by validation");
const b = await context.newPage();
await b.goto(BLOCK);
const { form: bf } = await waitForForm((f) => f.url === BLOCK);
const rb = bf ? await call("fill_form", { form_id: bf.form_id, facts: FACTS, answers: [{ field_id: bf.fields.find((x) => /Employee/.test(x.label)).id, value: "" }], advance: true }) : {};
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
const ra = anyf ? await call("fill_form", { form_id: anyf.form_id, facts: FACTS, answers: [{ field_id: anyf.fields[2].id, value: "Mission." }] }) : {};
ok(ra.filled === 3, `filled with suggestions + 1 answer (${ra.filled})`);
await a.close();

await client.close();
await context.close();
console.log(failures ? `\n${failures} check(s) failed` : "\nAll flow checks passed");
process.exit(failures ? 1 : 0);
