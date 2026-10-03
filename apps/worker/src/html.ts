// Small server-rendered pages: landing, sign-in/consent, messages. Everything dynamic is escaped.

export const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const STYLE = `
:root{--bg:#f7f7f5;--card:#fff;--text:#1d1d1f;--muted:#6b6b70;--line:#e3e3e0;--accent:#2f6fec;--accent-text:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#141416;--card:#1d1d20;--text:#ececef;--muted:#9a9aa2;--line:#2c2c31;--accent:#5b8ff5}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:440px;margin:56px auto;padding:0 16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px}
h1{font-size:20px;margin:0 0 6px}p{margin:8px 0}.muted{color:var(--muted);font-size:13px}
label{display:block;font-size:13px;margin:14px 0 4px;color:var(--muted)}
input{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:9px;background:var(--bg);color:var(--text);font:inherit}
button{width:100%;margin-top:14px;padding:11px;border:0;border-radius:9px;background:var(--accent);color:var(--accent-text);font:inherit;font-weight:600;cursor:pointer}
button.secondary{background:transparent;color:var(--text);border:1px solid var(--line)}
.or{display:flex;align-items:center;gap:10px;color:var(--muted);font-size:12px;margin:18px 0 4px}.or:before,.or:after{content:"";flex:1;border-top:1px solid var(--line)}
code{background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:2px 6px;font-size:13px;word-break:break-all}
.warn{background:#fff4e5;color:#7a4a00;border-radius:9px;padding:10px 12px;font-size:13px}
@media (prefers-color-scheme:dark){.warn{background:#3a2a10;color:#f3c77a}}
ol{padding-left:20px}li{margin:6px 0}
`;

export function page(title: string, body: string, status = 200, headers?: Headers): Response {
  const h = headers ?? new Headers();
  h.set("Content-Type", "text/html; charset=utf-8");
  h.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");
  h.set("X-Content-Type-Options", "nosniff");
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${STYLE}</style></head><body><main><div class="card">${body}</div></main></body></html>`,
    { status, headers: h },
  );
}

export function message(title: string, text: string, status = 200): Response {
  return page(title, `<h1>${esc(title)}</h1><p>${esc(text)}</p>`, status);
}

interface SignInOptions {
  heading: string;
  intro: string; // already-escaped HTML
  hidden: Record<string, string>;
  google: boolean;
  dev: boolean;
  showDeny?: boolean;
}

export function signInForm(o: SignInOptions): string {
  const hidden = Object.entries(o.hidden)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join("");
  const google = o.google
    ? `<form method="post">${hidden}<input type="hidden" name="method" value="google"><button>Continue with Google</button></form>`
    : "";
  const dev = o.dev
    ? `${o.google ? '<div class="or">or developer sign-in</div>' : ""}
       <form method="post">${hidden}<input type="hidden" name="method" value="dev">
         <label for="email">Email</label><input id="email" name="email" type="email" required autocomplete="email">
         <label for="passcode">Dev passcode</label><input id="passcode" name="passcode" type="password" required>
         <button${o.google ? ' class="secondary"' : ""}>Sign in</button></form>`
    : "";
  const deny = o.showDeny
    ? `<form method="post">${hidden}<input type="hidden" name="method" value="deny"><button class="secondary">Cancel</button></form>`
    : "";
  const none = !o.google && !o.dev ? `<p class="warn">Sign-in is not configured on this server yet.</p>` : "";
  return `<h1>${esc(o.heading)}</h1>${o.intro}${none}${google}${dev}${deny}`;
}
