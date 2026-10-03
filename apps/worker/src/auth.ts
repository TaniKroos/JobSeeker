// Sign-in helpers: Google OAuth (basic profile only), dev passcode login, signed cookies.

export const googleConfigured = (env: Env) => !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
export const devLoginEnabled = (env: Env) => !!env.DEV_PASSCODE;

const enc = new TextEncoder();

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function hmacKey(secret: string) {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function sign(secret: string, payload: unknown): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(body)));
  return `${body}.${b64url(sig)}`;
}

export async function verify<T>(secret: string, token: string | undefined | null): Promise<T | null> {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), fromB64url(sig), enc.encode(body));
  if (!ok) return null;
  try {
    return JSON.parse(new TextDecoder().decode(fromB64url(body))) as T;
  } catch {
    return null;
  }
}

export function timingSafeEqual(a: string, b: string): boolean {
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export function checkDevLogin(env: Env, email: unknown, passcode: unknown): string | null {
  if (!devLoginEnabled(env)) return null;
  if (typeof email !== "string" || typeof passcode !== "string") return null;
  const e = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return null;
  // Optional allowlist so the shared passcode can't be used to sign in as someone else.
  const allowed = (env.DEV_EMAILS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (allowed.length && !allowed.includes(e)) return null;
  return timingSafeEqual(passcode, env.DEV_PASSCODE) ? e : null;
}

// ---------- Google ----------

export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(verifier)));
  return { verifier, challenge: b64url(digest) };
}

export function googleAuthUrl(env: Env, redirectUri: string, state: string, codeChallenge: string): string {
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", "openid email");
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", codeChallenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("prompt", "select_account");
  return u.toString();
}

// Exchange the code and read the ID token. The token comes straight from Google over TLS,
// so its signature does not need to be checked here.
export async function googleUser(
  env: Env,
  code: string,
  redirectUri: string,
  verifier: string,
): Promise<{ email: string; sub: string }> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      code_verifier: verifier,
    }),
  });
  const data = (await res.json()) as { id_token?: string; error?: string };
  if (!res.ok || !data.id_token) throw new Error(`Google sign-in failed: ${data.error ?? res.status}`);
  const claims = JSON.parse(new TextDecoder().decode(fromB64url(data.id_token.split(".")[1])));
  if (!claims.email || !claims.email_verified) throw new Error("Google account has no verified email");
  return { email: claims.email, sub: claims.sub };
}

// ---------- cookies ----------

export function getCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get("Cookie") ?? "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

export const setCookie = (name: string, value: string, maxAge: number) =>
  `${name}=${value}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=${maxAge}`;

// Chrome extension redirect from chrome.identity.launchWebAuthFlow: https://<extension-id>.chromiumapp.org/...
export function validExtensionRedirect(env: Env, uri: string | undefined): string | null {
  if (!uri) return null;
  const m = /^https:\/\/([a-p]{32})\.chromiumapp\.org(\/[^\s#]*)?$/.exec(uri);
  if (!m) return null;
  const allowed = (env.EXTENSION_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (allowed.length && !allowed.includes(m[1])) return null;
  return uri;
}
