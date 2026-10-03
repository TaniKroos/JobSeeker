// Real-browser test: loads the built extension in Chromium, opens live application pages
// (Greenhouse, Lever, Ashby), and fills them through the whole chain:
// MCP client → Worker → user room → WebSocket → extension → page. It never submits.
//
// Prereqs: `wrangler dev` running (DEV_PASSCODE login), `npm run build -w apps/extension`.
// Usage: node scripts/browser-test.mjs [baseUrl] [screenshotDir]

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { chromium } from "playwright";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = process.argv[2] ?? "http://localhost:8787";
const SHOTS = process.argv[3] ?? "/tmp";
const PASSCODE = process.env.DEV_PASSCODE ?? "letmein";
const EMAIL = `browser-${Date.now()}@example.com`;
const EXT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.output/chrome-mv3");
const b64url = (b) => Buffer.from(b).toString("base64url");
const cookiesFrom = (res) => res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

async function connectorToken() {
  const redirect = "https://client.example.com/callback";
  const reg = await fetch(`${BASE}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Browser test", redirect_uris: [redirect], token_endpoint_auth_method: "none" }),
  }).then((r) => r.json());
  const verifier = b64url(crypto.randomBytes(32));
  const u = new URL(`${BASE}/authorize`);
  Object.entries({
    response_type: "code",
    client_id: reg.client_id,
    redirect_uri: redirect,
    state: "s",
    code_challenge: b64url(crypto.createHash("sha256").update(verifier).digest()),
    code_challenge_method: "S256",
    resource: `${BASE}/mcp`,
  }).forEach(([k, v]) => u.searchParams.set(k, v));
  const page = await fetch(u);
  const handle = /name="handle" value="([^"]+)"/.exec(await page.text())[1];
  const post = await fetch(`${BASE}/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookiesFrom(page) },
    body: new URLSearchParams({ handle, method: "dev", email: EMAIL, passcode: PASSCODE }),
  });
  const code = new URL(post.headers.get("location")).searchParams.get("code");
  const tok = await fetch(`${BASE}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirect, client_id: reg.client_id, code_verifier: verifier, resource: `${BASE}/mcp` }),
  }).then((r) => r.json());
  return tok.access_token;
}

async function extensionToken(extId) {
  const redirect = `https://${extId}.chromiumapp.org/cb`;
  const page = await fetch(`${BASE}/ext/login?redirect_uri=${encodeURIComponent(redirect)}`);
  const csrf = /name="csrf" value="([^"]+)"/.exec(await page.text())[1];
  const post = await fetch(`${BASE}/ext/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookiesFrom(page) },
    body: new URLSearchParams({ csrf, method: "dev", email: EMAIL, passcode: PASSCODE }),
  });
  return new URLSearchParams(post.headers.get("location").split("#")[1]).get("token");
}

// Find live application pages to try.
async function targets() {
  if (process.env.TARGET_URL) return [{ site: process.env.TARGET_SITE ?? "greenhouse", url: process.env.TARGET_URL }];
  const out = [];
  for (const board of ["gitlab", "airtable", "discord", "figma", "databricks"]) {
    const d = await fetch(`https://boards-api.greenhouse.io/v1/boards/${board}/jobs`).then((r) => (r.ok ? r.json() : null));
    const j = d?.jobs?.find((x) => /greenhouse\.io/.test(x.absolute_url));
    if (j) {
      out.push({ site: "greenhouse", url: j.absolute_url });
      break;
    }
  }
  const lever = await fetch("https://api.lever.co/v0/postings/palantir?mode=json&limit=1").then((r) => r.json());
  if (lever[0]) out.push({ site: "lever", url: `${lever[0].hostedUrl}/apply` });
  const ashby = await fetch("https://api.ashbyhq.com/posting-api/job-board/ramp").then((r) => r.json());
  if (ashby.jobs?.[0]) out.push({ site: "ashby", url: `${ashby.jobs[0].jobUrl}/application` });
  return out;
}

function answersFor(fields) {
  const answers = [];
  for (const f of fields) {
    if (f.kind === "file") continue;
    let value;
    if (/location|working from|city/i.test(f.label) && (f.kind === "text" || f.kind === "select")) {
      answers.push({ field_id: f.id, value: "Bangalore" });
      continue;
    }
    if (f.kind === "text") {
      value = { email: "test@example.com", tel: "9876543210", url: "https://example.com", number: "1", date: "2026-10-10" }[f.type] ?? "Test";
      if (/linkedin/i.test(f.label)) value = "https://linkedin.com/in/test";
    } else if (f.kind === "textarea") value = "This is a test answer written by the JobSeeker browser test.";
    else if (f.kind === "select") value = f.options?.[0] ?? "Yes";
    else if (f.kind === "radio") value = f.options?.[0];
    else if (f.kind === "checkbox") value = f.options?.slice(0, 1);
    if (value && (!Array.isArray(value) || value.length)) answers.push({ field_id: f.id, value });
  }
  return answers;
}

const parse = (r) => {
  const t = r.content?.[0]?.text ?? "";
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
};

// ---------- run ----------
const context = await chromium.launchPersistentContext("", {
  channel: "chromium",
  headless: true,
  viewport: { width: 1280, height: 900 },
  args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`],
});
let [sw] = context.serviceWorkers();
sw ??= await context.waitForEvent("serviceworker");
const extId = sw.url().split("/")[2];
console.log(`extension loaded: ${extId}`);

const [accessToken, extToken] = await Promise.all([connectorToken(), extensionToken(extId)]);
await sw.evaluate(([token, email, server]) => chrome.storage.local.set({ token, email, server }), [extToken, EMAIL, BASE]);

const client = new Client({ name: "browser-test", version: "0.0.1" });
await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { authorization: `Bearer ${accessToken}` } } }));

let failures = 0;
for (const t of await targets()) {
  console.log(`\n== ${t.site}: ${t.url}`);
  const page = await context.newPage();
  await page.goto(t.url, { waitUntil: "domcontentloaded", timeout: 45_000 });

  let form;
  for (let i = 0; i < 30 && !form; i++) {
    await page.waitForTimeout(1000);
    const r = parse(await client.callTool({ name: "get_open_forms", arguments: {} }));
    form = r.forms?.find((f) => f.site === t.site);
  }
  if (!form) {
    console.log("✗ no form captured");
    failures++;
    await page.screenshot({ path: `${SHOTS}/${t.site}-nocapture.png`, fullPage: true });
    await page.close();
    continue;
  }
  const kinds = form.fields.reduce((m, f) => ((m[f.kind] = (m[f.kind] ?? 0) + 1), m), {});
  console.log(`✓ captured ${form.fields.length} fields ${JSON.stringify(kinds)} · company="${form.company}" role="${form.role}"`);
  for (const f of form.fields.slice(0, 40)) console.log(`   ${f.id} [${f.kind}${f.required ? "*" : ""}] ${f.label.slice(0, 70)}${f.options ? ` (${f.options.length} opts)` : ""}`);

  const answers = answersFor(form.fields);
  const t0 = Date.now();
  const res = parse(await client.callTool({ name: "fill_form", arguments: { form_id: form.form_id, answers } }));
  console.log(`  (fill took ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  if (typeof res === "string") {
    console.log(`✗ fill_form: ${res}`);
    failures++;
  } else {
    console.log(`✓ filled ${res.filled}/${answers.length} answers`);
    for (const n of res.check_these ?? []) console.log(`   ~ ${n.label.slice(0, 60)} — ${n.note}`);
    for (const n of res.not_filled) console.log(`   · ${n.status}: ${n.label.slice(0, 60)}${n.note ? ` — ${n.note}` : ""}`);
    if (res.filled < answers.length * 0.6) failures++;
  }
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${SHOTS}/${t.site}-filled.png`, fullPage: true });
  await page.close();
}

// ---------- submit detection on a fake page (served at a Lever URL, nothing leaves the machine) ----------
console.log("\n== submit detection (fixture page)");
const FAKE = "https://jobs.lever.co/jctest/0000-fixture/apply";
const LONG = "I led a project that cut our API latency by 40% by redesigning the caching layer and adding load tests.";
await context.route(FAKE, (route) => {
  if (route.request().method() === "POST") {
    return route.fulfill({ contentType: "text/html", body: "<title>Thanks</title><h2>Thank you for applying!</h2><p>Your application has been submitted.</p>" });
  }
  return route.fulfill({
    contentType: "text/html",
    body: `<title>JC Test Co - Backend Engineer</title><h2>Backend Engineer</h2>
      <form method="post" action="${FAKE}">
        <label for="n">Full name *</label><input id="n" name="name" required>
        <label for="e">Email *</label><input id="e" name="email" type="email" required>
        <label for="q">Tell us about a project you are proud of</label><textarea id="q" name="q"></textarea>
        <button type="submit">Submit application</button>
      </form>`,
  });
});
const fp = await context.newPage();
await fp.goto(FAKE);
let fixture;
for (let i = 0; i < 20 && !fixture; i++) {
  await fp.waitForTimeout(500);
  fixture = parse(await client.callTool({ name: "get_open_forms", arguments: {} })).forms?.find((f) => f.url === FAKE);
}
if (!fixture) {
  console.log("✗ fixture form not captured");
  failures++;
} else {
  const ids = Object.fromEntries(fixture.fields.map((f) => [f.label, f.id]));
  await client.callTool({ name: "track_application", arguments: { company: "JC Test Co", role: "Backend Engineer", url: FAKE, status: "Applying" } });
  const r = parse(await client.callTool({ name: "fill_form", arguments: { form_id: fixture.form_id, answers: [
    { field_id: ids["Full name"], value: "Test User" },
    { field_id: ids["Email"], value: "test@example.com" },
    { field_id: ids["Tell us about a project you are proud of"], value: LONG },
  ] } }));
  console.log(`${r.filled === 3 ? "✓" : "✗"} fixture filled ${r.filled}/3 · company="${fixture.company}" role="${fixture.role}"`);
  await fp.click("button[type=submit]");
  let app;
  for (let i = 0; i < 20; i++) {
    await fp.waitForTimeout(500);
    const l = parse(await client.callTool({ name: "list_applications", arguments: {} }));
    app = l.applications?.find((a) => a.company === "JC Test Co");
    if (app?.status === "Applied") break;
  }
  const ok1 = app?.status === "Applied";
  console.log(`${ok1 ? "✓" : "✗"} after submit, tracker status = ${app?.status}`);
  if (!ok1) failures++;
}

await client.close();
await context.close();
console.log(failures ? `\n${failures} site(s) had problems` : "\nAll sites captured and filled");
process.exit(failures ? 1 : 0);
