// Routes that are not the MCP endpoint: the connector sign-in (/authorize), the extension
// sign-in and WebSocket, and a landing page.

import { Hono } from "hono";
import { AuthorizationError, CimdFetchError, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import {
  checkDevLogin,
  devLoginEnabled,
  getCookie,
  googleAuthUrl,
  googleConfigured,
  googleUser,
  pkcePair,
  setCookie,
  sign,
  validExtensionRedirect,
  verify,
} from "./auth";
import { createExtToken, revokeExtToken, upsertUser, userForExtToken, type User } from "./db";
import { esc, message, page, signInForm } from "./html";

type Bindings = Env & { OAUTH_PROVIDER: OAuthHelpers };
const app = new Hono<{ Bindings: Bindings }>();

const baseUrl = (env: Env) => env.PUBLIC_URL.replace(/\/$/, "");

// ---------- landing ----------

app.get("/", (c) => {
  const mcp = `${baseUrl(c.env)}/mcp`;
  return page(
    c.env.APP_NAME,
    `<h1>${esc(c.env.APP_NAME)}</h1>
     <p>Search jobs, fill applications and track them, right from Claude or ChatGPT.</p>
     <ol>
       <li>In Claude: <b>Settings → Connectors → Add custom connector</b> and paste <code>${esc(mcp)}</code> (ChatGPT: Settings → Apps &amp; Connectors → Developer mode).</li>
       <li>Install the Job Copilot Chrome extension and click <b>Connect</b>.</li>
       <li>Ask: <i>"Find backend jobs at Stripe in Bangalore"</i>, open one, and say <i>"fill it"</i>.</li>
     </ol>
     <p class="muted">You always review and submit applications yourself. <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a></p>`,
  );
});

app.get("/health", (c) => c.json({ ok: true }));

const contact = (env: Env) => (env.CONTACT_EMAIL ? `<p>Questions or deletion requests: <a href="mailto:${esc(env.CONTACT_EMAIL)}">${esc(env.CONTACT_EMAIL)}</a>.</p>` : "");

app.get("/privacy", (c) =>
  page(
    "Privacy · " + c.env.APP_NAME,
    `<h1>Privacy policy</h1>
     <p class="muted">Last updated 3 October 2026</p>
     <p>${esc(c.env.APP_NAME)} lets an AI assistant (Claude or ChatGPT) search jobs, fill job applications in your browser through our Chrome extension, and track your applications.</p>
     <h2 style="font-size:16px">What we store</h2>
     <ul>
       <li><b>Your account:</b> your email address and Google account ID from Google sign-in (scopes: openid, email, profile only).</li>
       <li><b>Your profile and saved answers:</b> facts you or your assistant save (e.g. name, phone, notice period) and answers to application questions, including long answers from applications you submit.</li>
       <li><b>Your application tracker:</b> company, role, status, dates and notes.</li>
       <li><b>Open application forms:</b> the questions on an application page while it is open, kept for at most 6 hours, so the assistant can answer them.</li>
     </ul>
     <h2 style="font-size:16px">What we don't do</h2>
     <ul>
       <li>We never read your email, files or other Google data, and never see passwords or payment details (the extension skips those fields).</li>
       <li>We never submit an application for you; you review and click Submit.</li>
       <li>We don't sell your data or use it for advertising. It is shared only with the AI assistant you connect, when it calls our tools.</li>
     </ul>
     <h2 style="font-size:16px">Where it lives, and deleting it</h2>
     <p>Data is stored on Cloudflare's infrastructure. Ask your assistant to “delete my Job Copilot data” to erase your profile, saved answers and tracker at any time, or disconnect the connector and extension to stop all access.</p>
     ${contact(c.env)}`,
  ),
);

app.get("/terms", (c) =>
  page(
    "Terms · " + c.env.APP_NAME,
    `<h1>Terms of use</h1>
     <p class="muted">Last updated 3 October 2026</p>
     <p>${esc(c.env.APP_NAME)} is provided as is, free of charge, while in early access. You are responsible for what you submit in job applications: always review the answers your assistant fills in before you submit.</p>
     <p>Don't use the service to submit false information, to apply on someone else's behalf without permission, or to overload job sites. We may suspend accounts that do.</p>
     <p>We may change or stop the service; we'll try to give notice through the site. See the <a href="/privacy">privacy policy</a> for how your data is handled.</p>
     ${contact(c.env)}`,
  ),
);

// ---------- MCP connector sign-in (OAuth for Claude / ChatGPT) ----------

function renderAuthError(err: unknown): Response {
  if (err instanceof AuthorizationError) {
    const redirectTo = (err as AuthorizationError & { redirectTo?: string }).redirectTo;
    if (redirectTo) return Response.redirect(redirectTo, 302);
    return message("Sign-in problem", `${err.description} Please start again from Claude.`, 400);
  }
  if (err instanceof CimdFetchError) return message("Sign-in problem", "This app could not be verified.", 400);
  throw err;
}

app.get("/authorize", async (c) => {
  const oauth = c.env.OAUTH_PROVIDER;
  try {
    const request = await oauth.parseAuthRequest(c.req.raw);
    const details = await oauth.describeConsent(request);
    const consent = await oauth.beginConsent(request);
    const intro = `<p><b>${esc(details.clientName || "An app")}</b> wants to use ${esc(c.env.APP_NAME)} on your behalf: search jobs, read your profile and saved answers, manage your application tracker and fill forms in your browser.</p>
      <p class="muted">${details.clientDomain ? `Published by ${esc(details.clientDomain)}. ` : "This app registered itself; its name is not verified. "}Access will be sent to <b>${esc(details.redirectHost)}</b>.</p>
      ${details.redirectIsLoopback ? '<p class="warn">This sends access to an app on your computer. Continue only if you just started connecting from it.</p>' : ""}`;
    return page(
      "Connect " + c.env.APP_NAME,
      signInForm({
        heading: `Connect ${c.env.APP_NAME}`,
        intro,
        hidden: { handle: consent.handle },
        google: googleConfigured(c.env),
        dev: devLoginEnabled(c.env),
        showDeny: true,
      }),
      200,
      consent.headers,
    );
  } catch (err) {
    return renderAuthError(err);
  }
});

app.post("/authorize", async (c) => {
  const oauth = c.env.OAUTH_PROVIDER;
  const form = await c.req.raw.formData();
  const handle = String(form.get("handle") ?? "");
  const method = form.get("method");
  try {
    if (method === "deny") {
      const denied = await oauth.denyConsent(c.req.raw, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    if (method === "dev") {
      const email = checkDevLogin(c.env, form.get("email"), form.get("passcode"));
      if (!email) return message("Sign-in failed", "Wrong email or passcode. Go back and try again.", 401);
      const approved = await oauth.approveConsent(c.req.raw, handle);
      const user = await upsertUser(c.env.DB, email);
      return finishConnector(oauth, approved.request, approved.headers, user);
    }
    if (method === "google" && googleConfigured(c.env)) {
      const approved = await oauth.approveConsent(c.req.raw, handle);
      const { verifier, challenge } = await pkcePair();
      const { state, headers } = await oauth.beginUpstream(approved.request, { data: { verifier }, headers: approved.headers });
      headers.set("Location", googleAuthUrl(c.env, `${baseUrl(c.env)}/auth/google/callback`, state, challenge));
      return new Response(null, { status: 302, headers });
    }
    return message("Sign-in problem", "Unknown sign-in method.", 400);
  } catch (err) {
    return renderAuthError(err);
  }
});

app.get("/auth/google/callback", async (c) => {
  const oauth = c.env.OAUTH_PROVIDER;
  try {
    const { request, data, headers } = await oauth.finishUpstream<{ verifier: string }>(c.req.raw);
    const code = c.req.query("code");
    if (!code) {
      const { authorizationErrorRedirect } = await import("@cloudflare/workers-oauth-provider");
      headers.set("Location", authorizationErrorRedirect(request, "access_denied"));
      return new Response(null, { status: 302, headers });
    }
    const g = await googleUser(c.env, code, `${baseUrl(c.env)}/auth/google/callback`, data.verifier);
    const user = await upsertUser(c.env.DB, g.email, g.sub);
    return finishConnector(oauth, request, headers, user);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Google")) return message("Sign-in failed", err.message, 400);
    return renderAuthError(err);
  }
});

async function finishConnector(
  oauth: OAuthHelpers,
  request: Awaited<ReturnType<OAuthHelpers["parseAuthRequest"]>>,
  headers: Headers,
  user: User,
): Promise<Response> {
  const { redirectTo } = await oauth.completeAuthorization({
    request,
    userId: user.id,
    metadata: { email: user.email },
    scope: request.scope,
    props: { userId: user.id, email: user.email },
  });
  headers.set("Location", redirectTo);
  return new Response(null, { status: 302, headers });
}

// ---------- Chrome extension sign-in ----------
// The extension opens /ext/login with chrome.identity.launchWebAuthFlow and receives
// https://<extension-id>.chromiumapp.org/#token=…&email=… back.

const EXT_COOKIE = "__Host-jc-ext";

interface ExtLoginState {
  redirect: string;
  csrf: string;
  state?: string;
  verifier?: string;
  exp: number;
}

async function extSuccess(env: Env, redirect: string, user: User): Promise<Response> {
  const token = await createExtToken(env.DB, user.id);
  const to = `${redirect}#token=${encodeURIComponent(token)}&email=${encodeURIComponent(user.email)}`;
  return new Response(null, {
    status: 302,
    headers: { Location: to, "Set-Cookie": setCookie(EXT_COOKIE, "", 0) },
  });
}

app.get("/ext/login", async (c) => {
  const redirect = validExtensionRedirect(c.env, c.req.query("redirect_uri"));
  if (!redirect) return message("Sign-in problem", "This sign-in link is not from the extension.", 400);
  const csrf = crypto.randomUUID();
  const cookie = await sign(c.env.SESSION_SECRET, { redirect, csrf, exp: Date.now() + 10 * 60_000 } satisfies ExtLoginState);
  return page(
    "Connect the extension",
    signInForm({
      heading: "Connect the Chrome extension",
      intro: `<p>Sign in with the same account you use in Claude so the extension can fill forms for you.</p>`,
      hidden: { csrf },
      google: googleConfigured(c.env),
      dev: devLoginEnabled(c.env),
    }),
    200,
    new Headers({ "Set-Cookie": setCookie(EXT_COOKIE, cookie, 600) }),
  );
});

app.post("/ext/login", async (c) => {
  const st = await verify<ExtLoginState>(c.env.SESSION_SECRET, getCookie(c.req.raw, EXT_COOKIE));
  const form = await c.req.raw.formData();
  if (!st || st.exp < Date.now() || form.get("csrf") !== st.csrf) {
    return message("Sign-in expired", "Close this window and click Connect in the extension again.", 400);
  }
  const method = form.get("method");
  if (method === "dev") {
    const email = checkDevLogin(c.env, form.get("email"), form.get("passcode"));
    if (!email) return message("Sign-in failed", "Wrong email or passcode. Go back and try again.", 401);
    return extSuccess(c.env, st.redirect, await upsertUser(c.env.DB, email));
  }
  if (method === "google" && googleConfigured(c.env)) {
    const { verifier, challenge } = await pkcePair();
    const state = crypto.randomUUID();
    const cookie = await sign(c.env.SESSION_SECRET, { ...st, state, verifier, exp: Date.now() + 10 * 60_000 });
    return new Response(null, {
      status: 302,
      headers: {
        Location: googleAuthUrl(c.env, `${baseUrl(c.env)}/ext/google/callback`, state, challenge),
        "Set-Cookie": setCookie(EXT_COOKIE, cookie, 600),
      },
    });
  }
  return message("Sign-in problem", "Unknown sign-in method.", 400);
});

app.get("/ext/google/callback", async (c) => {
  const st = await verify<ExtLoginState>(c.env.SESSION_SECRET, getCookie(c.req.raw, EXT_COOKIE));
  const code = c.req.query("code");
  if (!st?.state || !st.verifier || st.exp < Date.now() || c.req.query("state") !== st.state || !code) {
    return message("Sign-in expired", "Close this window and click Connect in the extension again.", 400);
  }
  try {
    const g = await googleUser(c.env, code, `${baseUrl(c.env)}/ext/google/callback`, st.verifier);
    return extSuccess(c.env, st.redirect, await upsertUser(c.env.DB, g.email, g.sub));
  } catch (err) {
    return message("Sign-in failed", err instanceof Error ? err.message : "Unknown error", 400);
  }
});

// ---------- extension API ----------

async function extUser(c: { env: Env; req: { header: (n: string) => string | undefined; query: (n: string) => string | undefined } }) {
  const auth = c.req.header("Authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice(7) : c.req.query("token");
  return token ? userForExtToken(c.env.DB, token) : null;
}

app.get("/ext/me", async (c) => {
  const user = await extUser(c);
  return user ? c.json({ email: user.email }) : c.json({ error: "unauthorized" }, 401);
});

app.post("/ext/logout", async (c) => {
  const auth = c.req.header("Authorization");
  if (auth?.startsWith("Bearer ")) await revokeExtToken(c.env.DB, auth.slice(7));
  return c.json({ ok: true });
});

// WebSocket from the extension's background worker. Browsers can't set headers on a
// WebSocket, so the token travels in the query string (over TLS).
app.get("/ext/ws", async (c) => {
  if (c.req.header("Upgrade") !== "websocket") return c.text("Expected WebSocket", 426);
  const user = await extUser(c);
  if (!user) return c.text("Unauthorized", 401);
  const room = c.env.USER_ROOM.get(c.env.USER_ROOM.idFromName(user.id));
  const headers = new Headers(c.req.raw.headers);
  headers.set("X-JC-User", JSON.stringify({ id: user.id, email: user.email }));
  return room.fetch(new Request(c.req.url, { headers }));
});

export default app;
