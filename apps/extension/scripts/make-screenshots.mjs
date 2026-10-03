// Product screenshots for the website and the Chrome Web Store, made with the real extension filling
// a demo application page (a fictional company, served locally by Playwright).
// Prereqs: `wrangler dev` (DEV_PASSCODE login), `wxt build`. Usage: node scripts/make-screenshots.mjs

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { chromium } from "playwright";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "http://localhost:8787";
const PASSCODE = process.env.DEV_PASSCODE ?? "letmein";
const EMAIL = `shots-${Date.now()}@example.com`;
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../../..");
const EXT_DIR = path.resolve(here, "../.output/chrome-mv3");
const SITE_OUT = path.join(ROOT, "apps/worker/public/screens");
const STORE_OUT = path.join(ROOT, "store-assets");
fs.mkdirSync(SITE_OUT, { recursive: true });
fs.mkdirSync(STORE_OUT, { recursive: true });
const svg = fs.readFileSync(path.join(ROOT, "assets/logo.svg"), "utf8");
const b64url = (b) => Buffer.from(b).toString("base64url");
const cookiesFrom = (res) => res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

async function connectorToken() {
  const redirect = "https://client.example.com/callback";
  const reg = await fetch(`${BASE}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Screenshots", redirect_uris: [redirect], token_endpoint_auth_method: "none" }) }).then((r) => r.json());
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

// ---------- demo pages (fictional company) ----------
const DEMO = "https://jobs.lever.co/northwind-demo/5f1c-demo/apply";
const JOBPAGE = "https://jobs.lever.co/northwind-demo/5f1c-demo";
const css = `*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:#1d2433;background:#f4f6fb}
header{background:#fff;border-bottom:1px solid #e3e7ef;padding:18px 48px;display:flex;align-items:center;gap:12px;font-weight:700;font-size:18px}
.mark{width:30px;height:30px;border-radius:8px;background:#0f766e;color:#fff;display:grid;place-items:center;font-size:15px}
main{max-width:760px;margin:28px auto;background:#fff;border:1px solid #e3e7ef;border-radius:14px;padding:32px 40px}
h1{font-size:24px;margin:0 0 4px}.sub{color:#5b6475;margin:0 0 22px}
label{display:block;font-weight:600;font-size:13px;margin:14px 0 6px}
input,select,textarea{width:100%;padding:10px 12px;border:1px solid #cfd6e3;border-radius:9px;font:inherit;background:#fff}
textarea{min-height:84px}.row{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.file{border:1.5px dashed #cfd6e3;border-radius:9px;padding:14px;color:#5b6475;font-size:13px}
button{margin-top:22px;padding:12px 22px;border:0;border-radius:9px;background:#0f766e;color:#fff;font-weight:700;font:inherit}`;
const DEMO_HTML = `<!doctype html><meta charset="utf-8"><title>Northwind Labs - Backend Engineer</title><style>${css}</style>
<header><span class="mark">N</span>Northwind Labs <span style="font-weight:400;color:#5b6475;margin-left:6px">Careers</span></header>
<main><h1>Backend Engineer</h1><p class="sub">Bengaluru · Full-time · Platform team</p>
<form onsubmit="return false">
<div class="row"><div><label for="fn">First name *</label><input id="fn" required></div><div><label for="ln">Last name *</label><input id="ln" required></div></div>
<div class="row"><div><label for="em">Email *</label><input id="em" type="email" required></div><div><label for="ph">Phone *</label><input id="ph" type="tel" required></div></div>
<label for="li">LinkedIn profile</label><input id="li" type="url">
<div class="row"><div><label for="ct">Country of residence *</label><select id="ct" required><option value="">Select…</option><option>India</option><option>United States</option><option>Germany</option></select></div>
<div><label for="sp">Will you require visa sponsorship? *</label><select id="sp" required><option value="">Select…</option><option>Yes</option><option>No</option></select></div></div>
<label for="why">Why do you want to join Northwind? *</label><textarea id="why" required></textarea>
<label for="cv">Resume / CV *</label><div class="file"><input id="cv" type="file" required></div>
<button type="submit">Submit application</button></form></main>`;
const JOB_HTML = `<!doctype html><meta charset="utf-8"><title>Northwind Labs - Backend Engineer</title><style>${css} .apply{display:inline-block;margin-top:18px;padding:12px 22px;border-radius:9px;background:#0f766e;color:#fff;font-weight:700;text-decoration:none}</style>
<header><span class="mark">N</span>Northwind Labs <span style="font-weight:400;color:#5b6475;margin-left:6px">Careers</span></header>
<main><h1>Backend Engineer</h1><p class="sub">Bengaluru · Full-time · Platform team</p>
<p>We're looking for a backend engineer to build the services behind our logistics platform: APIs in Go and TypeScript, event pipelines, and the reliability work that keeps them fast.</p>
<p><b>You'll</b> design and ship services end to end, own on-call for what you build, and work closely with product and data teams.</p>
<p><b>You have</b> 2+ years building production backends, solid SQL, and care about clean, well-tested code.</p>
<a class="apply" href="${DEMO}">Apply for this job</a></main>`;

const context = await chromium.launchPersistentContext("", {
  channel: "chromium",
  headless: true,
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1,
  args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`],
});
await context.route(DEMO, (r) => r.fulfill({ contentType: "text/html", body: DEMO_HTML }));
await context.route(JOBPAGE, (r) => r.fulfill({ contentType: "text/html", body: JOB_HTML }));
let [sw] = context.serviceWorkers();
sw ??= await context.waitForEvent("serviceworker");
const extId = sw.url().split("/")[2];
const [accessToken, extToken] = await Promise.all([connectorToken(), extensionToken(extId)]);
await sw.evaluate(([token, email, server]) => chrome.storage.local.set({ token, email, server }), [extToken, "asha.rao@example.com", BASE]);
const client = new Client({ name: "shots", version: "1" });
await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { authorization: `Bearer ${accessToken}` } } }));
const call = async (name, args = {}) => parse(await client.callTool({ name, arguments: args }));
const FACTS = { full_name: "Asha Rao", email: "asha.rao@example.com", phone: "+91 98765 43210", linkedin: "https://linkedin.com/in/asharao", country: "India", requires_sponsorship: "no" };

// 1. Job page with the "Open application" pill
const job = await context.newPage();
await job.goto(JOBPAGE);
await job.waitForTimeout(3500);
await job.screenshot({ path: path.join(SITE_OUT, "job-page.png") });

// 2. Application captured ("fields ready"), then filled
const page = await context.newPage();
await page.goto(DEMO);
let form;
for (let i = 0; i < 30 && !form; i++) {
  await page.waitForTimeout(500);
  form = (await call("get_open_forms", { facts: FACTS })).forms?.find((f) => f.url === DEMO);
}
await page.screenshot({ path: path.join(SITE_OUT, "ready.png") });
const why = form.fields.find((f) => /Why/.test(f.label));
const res = await call("fill_form", {
  form_id: form.form_id,
  facts: FACTS,
  answers: [{ field_id: why.id, value: "Northwind's platform team works on exactly the problems I enjoy: reliable event pipelines and APIs at scale. I built similar services at my last role and want to grow on a team that owns them end to end." }],
});
console.log(`filled ${res.filled}, needs you: ${res.not_filled.map((n) => n.label).join(", ")}`);
await page.waitForTimeout(800);
await page.evaluate(() => window.scrollTo(0, 0));
await page.screenshot({ path: path.join(SITE_OUT, "filled.png") });

// 3. The extension popup
const popup = await context.newPage();
await popup.setViewportSize({ width: 340, height: 420 });
await popup.goto(`chrome-extension://${extId}/popup.html`);
await popup.waitForTimeout(700);
// show it the way the store build looks (no developer settings or all-sites option)
await popup.addStyleTag({ content: "#dev,#allSitesRow{display:none!important}" });
await popup.screenshot({ path: path.join(SITE_OUT, "popup.png") });
await client.close();

// ---------- store images: captioned 1280×800 screenshots and the 440×280 promo tile ----------
const store = await context.newPage();
const img = (f) => `data:image/png;base64,${fs.readFileSync(path.join(SITE_OUT, f)).toString("base64")}`;
async function framed(file, title, sub, shot, opts = {}) {
  await store.setViewportSize({ width: 1280, height: 800 });
  await store.setContent(`<style>body{margin:0;width:1280px;height:800px;overflow:hidden;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:linear-gradient(135deg,#0f1b3d,#2459e0);color:#fff}
    .top{display:flex;align-items:center;gap:16px;padding:34px 56px 0}.top svg{width:44px;height:44px}
    h1{font-size:40px;margin:0;letter-spacing:-.5px}p{margin:6px 0 0;font-size:20px;opacity:.85}
    .shot{position:absolute;left:${opts.left ?? 120}px;top:${opts.top ?? 170}px;width:${opts.width ?? 1040}px;border-radius:14px;box-shadow:0 24px 60px rgba(0,0,0,.45);overflow:hidden;background:#fff}
    .shot img{display:block;width:100%}</style>
    <div class="top">${svg}<div><h1>${title}</h1><p>${sub}</p></div></div><div class="shot"><img src="${shot}"></div>`);
  await store.screenshot({ path: path.join(STORE_OUT, file) });
}
await framed("screenshot-1-job-page.png", "From job page to application in one click", "JobSeeker spots the job page and takes you to the form.", img("job-page.png"));
await framed("screenshot-2-ready.png", "Then just say “fill it”", "JobSeeker reads the form and your AI assistant answers it, multi-page forms included.", img("ready.png"));
await framed("screenshot-3-review.png", "Review, then submit yourself", "Answers are highlighted; anything that needs you (like your résumé) is outlined. Nothing is submitted for you.", img("filled.png"));
await framed("screenshot-4-popup.png", "Connect once, then just apply", "Sign in with Google. Works on Greenhouse, Lever, Ashby, Workday, Oracle and more.", img("popup.png"), { left: 470, width: 340, top: 190 });
await store.setViewportSize({ width: 440, height: 280 });
await store.setContent(`<style>body{margin:0;width:440px;height:280px;display:flex;align-items:center;gap:20px;padding:0 30px;box-sizing:border-box;
  background:linear-gradient(135deg,#0f1b3d,#2459e0);color:#fff;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
  svg{width:96px;height:96px;flex:none}h1{font-size:34px;margin:0 0 6px}p{margin:0;font-size:16px;opacity:.9;line-height:1.35}</style>
  ${svg}<div><h1>JobSeeker</h1><p>Your AI assistant fills job applications. You review and submit.</p></div>`);
await store.screenshot({ path: path.join(STORE_OUT, "promo-small-440x280.png") });
fs.copyFileSync(path.join(ROOT, "apps/extension/public/icon/128.png"), path.join(STORE_OUT, "icon-128.png"));
await context.close();
console.log("screenshots written to apps/worker/public/screens and store-assets/");
