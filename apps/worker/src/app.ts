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
import { homePage, privacyPage, termsPage } from "./pages";

type Bindings = Env & { OAUTH_PROVIDER: OAuthHelpers };
const app = new Hono<{ Bindings: Bindings }>();

const baseUrl = (env: Env) => env.PUBLIC_URL.replace(/\/$/, "");

// ---------- public pages ----------

const nonce = () => crypto.randomUUID().replace(/-/g, "");

app.get("/", (c) => homePage(baseUrl(c.env), c.env.CHROME_STORE_URL ?? "", nonce()));
app.get("/privacy", () => privacyPage());
app.get("/terms", () => termsPage());
app.get("/health", (c) => c.json({ ok: true }));

// ---------- MCP connector sign-in (OAuth for Claude / ChatGPT) ----------

function renderAuthError(err: unknown): Response {
  if (err instanceof AuthorizationError) {
    const redirectTo = (err as AuthorizationError & { redirectTo?: string }).redirectTo;
    if (redirectTo) return Response.redirect(redirectTo, 302);
    return message("Sign-in problem", `${err.description} Close this window and start connecting again from Claude or ChatGPT.`, 400);
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
    const client = details.clientName || "An app";
    const intro = `<p><b>${esc(client)}</b> wants to use JobSeeker for you.</p>
      <p class="muted">${details.clientDomain ? `Published by <b>${esc(details.clientDomain)}</b>. ` : "This app registered itself, so its name isn't verified. "}Access goes to <b>${esc(details.redirectHost)}</b>.</p>
      ${details.redirectIsLoopback ? '<p class="warn">This sends access to an app on your computer. Continue only if you just started connecting from it.</p>' : ""}
      <p style="margin-bottom:0">It will be able to:</p>`;
    const n = nonce();
    return page(
      `Connect JobSeeker to ${client}`,
      signInForm({
        heading: `Connect JobSeeker to ${client}`,
        intro,
        abilities: ["Search companies' job boards for you", "Read and fill application forms you open in Chrome (never submit them)", "Keep your list of applications (company, role, link, status; 90 days)"],
        hidden: { handle: consent.handle },
        google: googleConfigured(c.env),
        dev: devLoginEnabled(c.env),
        showCancel: true,
        nonce: n,
      }),
      { headers: consent.headers, nav: false, bare: true, nonce: n },
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
    return message("Sign-in problem", "That sign-in option isn't available. Close this window and try connecting again.", 400);
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
    if (err instanceof Error && err.message.startsWith("Google")) return message("Sign-in failed", `${err.message}. Close this window and try connecting again.`, 400);
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
  if (!redirect) return message("Sign-in problem", "This sign-in link didn't come from the JobSeeker extension. Click Connect in the extension to try again.", 400);
  const csrf = crypto.randomUUID();
  const cookie = await sign(c.env.SESSION_SECRET, { redirect, csrf, exp: Date.now() + 10 * 60_000 } satisfies ExtLoginState);
  const n = nonce();
  return page(
    "Connect the JobSeeker extension",
    signInForm({
      heading: "Connect the JobSeeker extension",
      intro: `<p>Sign in with the same Google account you use with the JobSeeker connector in Claude or ChatGPT.</p><p style="margin-bottom:0">The extension will:</p>`,
      abilities: ["Read the questions on job applications you open", "Fill in the answers your assistant gives it, highlighted for review", "Never submit anything: you click Submit"],
      hidden: { csrf },
      google: googleConfigured(c.env),
      dev: devLoginEnabled(c.env),
      nonce: n,
    }),
    { headers: new Headers({ "Set-Cookie": setCookie(EXT_COOKIE, cookie, 600) }), nav: false, bare: true, nonce: n },
  );
});

app.post("/ext/login", async (c) => {
  const st = await verify<ExtLoginState>(c.env.SESSION_SECRET, getCookie(c.req.raw, EXT_COOKIE));
  const form = await c.req.raw.formData();
  if (!st || st.exp < Date.now() || form.get("csrf") !== st.csrf) {
    return message("Sign-in expired", "This sign-in window timed out. Close it and click Connect in the extension again.", 400);
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
  return message("Sign-in problem", "That sign-in option isn't available. Close this window and click Connect again.", 400);
});

app.get("/ext/google/callback", async (c) => {
  const st = await verify<ExtLoginState>(c.env.SESSION_SECRET, getCookie(c.req.raw, EXT_COOKIE));
  const code = c.req.query("code");
  if (!st?.state || !st.verifier || st.exp < Date.now() || c.req.query("state") !== st.state || !code) {
    return message("Sign-in expired", "This sign-in window timed out. Close it and click Connect in the extension again.", 400);
  }
  try {
    const g = await googleUser(c.env, code, `${baseUrl(c.env)}/ext/google/callback`, st.verifier);
    return extSuccess(c.env, st.redirect, await upsertUser(c.env.DB, g.email, g.sub));
  } catch (err) {
    return message("Sign-in failed", `${err instanceof Error ? err.message : "Something went wrong"}. Close this window and click Connect again.`, 400);
  }
});

// ---------- extension API ----------

async function extUser(c: { env: Env; req: { header: (n: string) => string | undefined; query: (n: string) => string | undefined } }) {
  const auth = c.req.header("Authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
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

// Browsers can't set headers on a WebSocket, so the extension first trades its token (in a header)
// for a short-lived signed ticket and puts only that in the URL. Request logs never see the token.
const TICKET_TTL_MS = 60_000;

app.post("/ext/ws-ticket", async (c) => {
  const auth = c.req.header("Authorization");
  const user = auth?.startsWith("Bearer ") ? await userForExtToken(c.env.DB, auth.slice(7)) : null;
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const ticket = await sign(c.env.SESSION_SECRET, { t: "ws", id: user.id, email: user.email, exp: Date.now() + TICKET_TTL_MS });
  return c.json({ ticket });
});

app.get("/ext/ws", async (c) => {
  if (c.req.header("Upgrade") !== "websocket") return c.text("Expected WebSocket", 426);
  const t = await verify<{ t: string; id: string; email: string; exp: number }>(c.env.SESSION_SECRET, c.req.query("ticket"));
  const user: User | null = t?.t === "ws" && t.exp > Date.now() ? { id: t.id, email: t.email } : null;
  if (!user) return c.text("Unauthorized", 401);
  const room = c.env.USER_ROOM.get(c.env.USER_ROOM.idFromName(user.id));
  const headers = new Headers(c.req.raw.headers);
  headers.set("X-JC-User", JSON.stringify({ id: user.id, email: user.email }));
  return room.fetch(new Request(c.req.url, { headers }));
});

export default app;
