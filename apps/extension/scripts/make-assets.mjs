// Renders the logo into the PNG icons the extension needs (and a social preview image for the site).
// Usage: node scripts/make-assets.mjs
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const svg = fs.readFileSync(path.join(root, "assets/logo.svg"), "utf8");
const browser = await chromium.launch({ channel: "chromium" });
const page = await browser.newPage({ deviceScaleFactor: 1 });

for (const size of [16, 32, 48, 128]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{width:${size}px;height:${size}px;display:block}</style>${svg}`);
  await page.screenshot({ path: path.join(root, `apps/extension/public/icon/${size}.png`), omitBackground: true });
}

// 1200×630 social preview for jobs.smudgee.xyz
await page.setViewportSize({ width: 1200, height: 630 });
await page.setContent(`<style>
  body{margin:0;width:1200px;height:630px;display:flex;align-items:center;gap:56px;padding:0 96px;box-sizing:border-box;
    background:linear-gradient(135deg,#0f1b3d,#2459e0);color:#fff;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
  svg{width:200px;height:200px;flex:none;filter:drop-shadow(0 12px 32px rgba(0,0,0,.35))}
  h1{font-size:76px;margin:0 0 12px;letter-spacing:-1px}p{font-size:34px;margin:0;opacity:.9;line-height:1.3}
</style>${svg}<div><h1>JobSeeker</h1><p>Your AI assistant fills job applications.<br>You review and submit.</p></div>`);
await page.screenshot({ path: path.join(root, "apps/worker/public/og.png") });
await browser.close();
console.log("icons and og.png written");
