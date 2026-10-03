// Server-rendered pages: shared layout, sign-in windows, messages. Everything dynamic is escaped.

export const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const LOGO = `<svg viewBox="0 0 128 128" aria-hidden="true"><rect width="128" height="128" rx="30" fill="#2459E0"/><circle cx="56" cy="56" r="29" fill="none" stroke="#fff" stroke-width="12"/><path d="M78.5 78.5 101 101" stroke="#fff" stroke-width="15" stroke-linecap="round"/><path d="M43.5 56.5 52.5 65.5 69.5 47.5" fill="none" stroke="#fff" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

// Google's "G" mark for the sign-in button (per Google's branding guidelines).
const G_MARK = `<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>`;

const STYLE = `
:root{--bg:#f6f7fb;--card:#fff;--text:#161a23;--muted:#5d6475;--line:#e3e6ee;--accent:#2459e0;--accent-text:#fff;--soft:#eef2fd;--warn-bg:#fff4e5;--warn:#7a4a00;--g-bg:#fff;--g-line:#747775;--g-text:#1f1f1f}
@media (prefers-color-scheme:dark){:root{--bg:#111318;--card:#1a1d24;--text:#eceef3;--muted:#9ba2b2;--line:#2b303b;--accent:#5b86f0;--soft:#1e2433;--warn-bg:#3a2a10;--warn:#f3c77a;--g-bg:#131314;--g-line:#8e918f;--g-text:#e3e3e3}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--accent)}a:focus-visible,button:focus-visible,input:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:6px}
.wrap{max-width:1040px;margin:0 auto;padding:0 20px}
.top{display:flex;align-items:center;gap:10px;padding:18px 20px}
.brand{display:flex;align-items:center;gap:10px;color:var(--text);text-decoration:none;font-weight:700;font-size:18px}
.brand svg{width:32px;height:32px}
.top nav{margin-left:auto;display:flex;gap:18px;font-size:14px}.top nav a{color:var(--muted);text-decoration:none}.top nav a:hover{color:var(--text)}
footer.site{border-top:1px solid var(--line);margin-top:56px;padding:22px 0 36px;color:var(--muted);font-size:14px}
footer.site .wrap{display:flex;flex-wrap:wrap;gap:8px 20px}footer.site a{color:var(--muted)}
.narrow{max-width:460px;margin:24px auto 0;padding:0 16px}
.doc{max-width:760px;margin:12px auto 0;padding:0 20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:28px}
h1{font-size:24px;line-height:1.25;margin:0 0 8px}h2{font-size:18px;margin:28px 0 8px}p{margin:10px 0}
.muted{color:var(--muted);font-size:14px}
ul.can{padding-left:0;list-style:none;margin:14px 0}ul.can li{padding-left:26px;position:relative;margin:7px 0;font-size:15px}
ul.can li:before{content:"";position:absolute;left:4px;top:8px;width:10px;height:6px;border-left:2px solid var(--accent);border-bottom:2px solid var(--accent);transform:rotate(-45deg)}
.btn{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;margin-top:14px;padding:11px 14px;border:0;border-radius:10px;background:var(--accent);color:var(--accent-text);font:inherit;font-weight:600;cursor:pointer;text-decoration:none}
.btn.secondary{background:transparent;color:var(--text);border:1px solid var(--line)}
.gbtn{display:flex;align-items:center;justify-content:center;gap:12px;width:100%;height:44px;margin-top:18px;padding:0 14px;border-radius:22px;border:1px solid var(--g-line);background:var(--g-bg);color:var(--g-text);font:500 15px/1 Roboto,system-ui,sans-serif;cursor:pointer}
.gbtn svg{width:20px;height:20px}.gbtn[disabled],.btn[disabled]{opacity:.6;cursor:progress}
.spin{width:16px;height:16px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:s .7s linear infinite;display:none}
[data-loading] .spin{display:inline-block}[data-loading] svg{display:none}@keyframes s{to{transform:rotate(1turn)}}
.warn{background:var(--warn-bg);color:var(--warn);border-radius:10px;padding:10px 12px;font-size:14px}
label{display:block;font-size:13px;margin:12px 0 4px;color:var(--muted)}
input{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:9px;background:var(--bg);color:var(--text);font:inherit}
details.dev{margin-top:18px;border-top:1px solid var(--line);padding-top:10px}details.dev summary{cursor:pointer;color:var(--muted);font-size:13px}
code{background:var(--soft);border-radius:6px;padding:2px 6px;font-size:14px;word-break:break-all}
table{width:100%;border-collapse:collapse;font-size:15px;margin:10px 0}th,td{text-align:left;vertical-align:top;padding:9px 10px;border-bottom:1px solid var(--line)}th{color:var(--muted);font-weight:600;font-size:13px}
.legal li{margin:6px 0}
`;

export interface PageOptions {
  status?: number;
  headers?: Headers;
  description?: string;
  extraStyle?: string;
  nav?: boolean; // site navigation in the header (off for small sign-in windows)
  nonce?: string; // for an inline <script nonce>
  bare?: boolean; // no site footer (sign-in windows)
}

export function page(title: string, body: string, o: PageOptions = {}): Response {
  const h = o.headers ?? new Headers();
  h.set("Content-Type", "text/html; charset=utf-8");
  h.set(
    "Content-Security-Policy",
    `default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; ${o.nonce ? `script-src 'nonce-${o.nonce}'; ` : ""}frame-ancestors 'none'; base-uri 'none'`, // no form-action: Chrome applies it to the redirect back to Claude
  );
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "strict-origin-when-cross-origin");
  const desc = o.description ?? "Your AI assistant fills job applications for you. You review and submit.";
  const nav = o.nav === false ? "" : `<nav><a href="/#how">How it works</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a></nav>`;
  const footer = o.bare
    ? ""
    : `<footer class="site"><div class="wrap"><span>© 2026 JobSeeker</span><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="mailto:tanishsaini26@gmail.com">Contact</a></div></footer>`;
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(desc)}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:image" content="https://jobs.smudgee.xyz/og.png"><meta property="og:type" content="website"><meta name="twitter:card" content="summary_large_image">
<style>${STYLE}${o.extraStyle ?? ""}</style></head>
<body><header class="wrap top"><a class="brand" href="/">${LOGO}<span>JobSeeker</span></a>${nav}</header>${body}${footer}</body></html>`,
    { status: o.status ?? 200, headers: h },
  );
}

export function message(title: string, text: string, status = 200, retry?: { href: string; label: string }): Response {
  return page(
    title,
    `<main class="narrow"><div class="card"><h1>${esc(title)}</h1><p>${esc(text)}</p>${retry ? `<a class="btn" href="${esc(retry.href)}">${esc(retry.label)}</a>` : ""}</div></main>`,
    { status, nav: false },
  );
}

interface SignInOptions {
  heading: string;
  intro: string; // already-escaped HTML
  abilities: string[]; // plain text, escaped here
  hidden: Record<string, string>;
  google: boolean;
  dev: boolean;
  showCancel?: boolean;
  nonce: string;
}

// The window that opens when connecting Claude/ChatGPT or the extension.
export function signInForm(o: SignInOptions): string {
  const hidden = Object.entries(o.hidden)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join("");
  const google = o.google
    ? `<form method="post" data-busy>${hidden}<input type="hidden" name="method" value="google"><button class="gbtn" type="submit">${G_MARK}<span class="spin"></span><span>Continue with Google</span></button></form>`
    : "";
  const dev = o.dev
    ? `<details class="dev"${o.google ? "" : " open"}><summary>Developer sign-in</summary><form method="post" data-busy>${hidden}<input type="hidden" name="method" value="dev">
         <label for="email">Email</label><input id="email" name="email" type="email" required autocomplete="email">
         <label for="passcode">Dev passcode</label><input id="passcode" name="passcode" type="password" required>
         <button class="btn secondary" type="submit"><span class="spin"></span>Sign in</button></form></details>`
    : "";
  const cancel = o.showCancel
    ? `<form method="post">${hidden}<input type="hidden" name="method" value="deny"><button class="btn secondary" type="submit">Cancel</button></form>`
    : "";
  const none = !o.google && !o.dev ? `<p class="warn">Sign-in isn't available right now. Please try again later.</p>` : "";
  const abilities = `<ul class="can">${o.abilities.map((a) => `<li>${esc(a)}</li>`).join("")}</ul>`;
  return `<main class="narrow"><div class="card"><h1>${esc(o.heading)}</h1>${o.intro}${abilities}${none}${google}${cancel}${dev}
    <p class="muted" style="margin-top:16px">By continuing you agree to the <a href="/terms" target="_blank">Terms</a> and <a href="/privacy" target="_blank">Privacy policy</a>. JobSeeker never submits an application for you.</p></div></main>
    <script nonce="${esc(o.nonce)}">document.querySelectorAll("form[data-busy]").forEach(function(f){f.addEventListener("submit",function(){var b=f.querySelector("button[type=submit]");b.setAttribute("data-loading","");b.disabled=true;var t=b.querySelector("span:last-child");if(t&&f.querySelector("[value=google]"))t.textContent="Opening Google…";});});</script>`;
}

export { LOGO };
