// Background service worker: owns the account, the WebSocket to the user's room on the server,
// and the map of which tab/frame holds which captured form.

import type { CapturedForm, ExtToServer, ServerToExt } from "@job-copilot/shared";
import { PING } from "@job-copilot/shared";
import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";
import type { BgMsg, BgStatus, ContentMsg, FillResponse } from "../lib/page";

const DEFAULT_SERVER: string = import.meta.env.WXT_SERVER_URL || "http://localhost:8787";
const PING_MS = 20_000; // under Chrome's 30s idle limit, keeps the worker and socket alive
const IDLE_CLOSE_MS = 60_000; // close the socket a minute after the last form goes away
const SUBMIT_WINDOW_MS = 3 * 60_000;

interface FormEntry {
  tabId: number;
  frameId: number;
  form: CapturedForm;
}
type SubmitAttempt = Extract<ContentMsg, { type: "submit_attempt" }> & { at: number };

export type PopupMsg =
  | { type: "popup:state" }
  | { type: "popup:connect" }
  | { type: "popup:disconnect" }
  | { type: "popup:inject"; tabId: number }
  | { type: "popup:server"; server: string }
  | { type: "popup:allsites"; enabled: boolean };

export interface PopupState {
  email?: string;
  server: string;
  connected: boolean;
  allSites: boolean;
  forms: { company?: string; role?: string; fields: number; step: number }[];
}

const ALL_SITES_ID = "jc-all-sites";

// Opt-in: run on every website (the script stays idle unless the page has a form or a job posting).
async function syncAllSites(enabled: boolean) {
  const registered = await browser.scripting.getRegisteredContentScripts({ ids: [ALL_SITES_ID] }).catch(() => []);
  if (enabled && !registered.length) {
    await browser.scripting.registerContentScripts([
      { id: ALL_SITES_ID, js: ["/auto.js"], matches: ["<all_urls>"], allFrames: true, runAt: "document_idle", persistAcrossSessions: true },
    ]);
  } else if (!enabled && registered.length) {
    await browser.scripting.unregisterContentScripts({ ids: [ALL_SITES_ID] });
  }
}
const hasAllSites = () => browser.permissions.contains({ origins: ["<all_urls>"] });

export default defineBackground(() => {
  let ws: WebSocket | null = null;
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let retryMs = 1000;
  const outbox: ExtToServer[] = [];

  // Forms and pending submits survive a service-worker restart in session storage.
  const forms = new Map<string, FormEntry>();
  const pages = new Map<string, number>(); // job pages without a form: session → tabId
  const submits = new Map<number, SubmitAttempt>();
  const ready = browser.storage.session.get(["forms", "pages", "submits"]).then((s) => {
    for (const [k, v] of Object.entries((s.forms ?? {}) as Record<string, FormEntry>)) forms.set(k, v);
    for (const [k, v] of Object.entries((s.pages ?? {}) as Record<string, number>)) pages.set(k, v);
    for (const [k, v] of Object.entries((s.submits ?? {}) as Record<string, SubmitAttempt>)) submits.set(Number(k), v);
  });
  const persist = () =>
    browser.storage.session.set({ forms: Object.fromEntries(forms), pages: Object.fromEntries(pages), submits: Object.fromEntries(submits) });
  hasAllSites().then(syncAllSites).catch(() => undefined);

  // ---------- account ----------

  async function auth(): Promise<{ token?: string; email?: string; server: string }> {
    const s = await browser.storage.local.get(["token", "email", "server"]);
    return { token: s.token as string | undefined, email: s.email as string | undefined, server: (s.server as string) || DEFAULT_SERVER };
  }

  async function connectAccount(): Promise<void> {
    const { server } = await auth();
    const redirect = browser.identity.getRedirectURL("cb");
    const result = await browser.identity.launchWebAuthFlow({
      url: `${server}/ext/login?redirect_uri=${encodeURIComponent(redirect)}`,
      interactive: true,
    });
    const hash = new URLSearchParams((result ?? "").split("#")[1] ?? "");
    const token = hash.get("token");
    if (!token) throw new Error("Sign-in was cancelled");
    await browser.storage.local.set({ token, email: hash.get("email") ?? "" });
    closeSocket();
    ensureSocket();
    broadcastStatus();
  }

  async function disconnectAccount(): Promise<void> {
    const { token, server } = await auth();
    if (token) fetch(`${server}/ext/logout`, { method: "POST", headers: { authorization: `Bearer ${token}` } }).catch(() => undefined);
    await browser.storage.local.remove(["token", "email"]);
    closeSocket();
    broadcastStatus();
  }

  async function status(): Promise<BgStatus> {
    const { token } = await auth();
    return { signedIn: !!token, connected: ws?.readyState === WebSocket.OPEN };
  }

  // ---------- socket ----------

  function wsSend(msg: ExtToServer) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    else {
      outbox.push(msg);
      ensureSocket();
    }
  }

  function closeSocket() {
    clearInterval(pingTimer);
    const s = ws;
    ws = null;
    s?.close();
  }

  async function ensureSocket() {
    await ready;
    clearTimeout(idleTimer);
    if (!forms.size && !pages.size && !outbox.length) {
      idleTimer = setTimeout(() => {
        if (!forms.size && !pages.size && !outbox.length) closeSocket();
      }, IDLE_CLOSE_MS);
      return;
    }
    if (ws && ws.readyState <= WebSocket.OPEN) return;
    const { token, server } = await auth();
    if (!token) return;

    const sock = new WebSocket(`${server.replace(/^http/, "ws")}/ext/ws?token=${encodeURIComponent(token)}`);
    ws = sock;
    let opened = false;
    sock.onopen = () => {
      opened = true;
      retryMs = 1000;
      for (const e of forms.values()) sock.send(JSON.stringify({ type: "form", form: e.form } satisfies ExtToServer));
      while (outbox.length) sock.send(JSON.stringify(outbox.shift()));
      clearInterval(pingTimer);
      pingTimer = setInterval(() => sock.readyState === WebSocket.OPEN && sock.send(PING), PING_MS);
      broadcastStatus();
    };
    sock.onmessage = (ev) => {
      if (typeof ev.data !== "string" || ev.data === "pong") return;
      const msg = JSON.parse(ev.data) as ServerToExt;
      if (msg.type === "fill") routeFill(msg);
    };
    sock.onclose = async () => {
      if (ws !== sock) return; // replaced or closed on purpose
      ws = null;
      clearInterval(pingTimer);
      broadcastStatus();
      if (!opened) {
        // handshake refused: token revoked or expired?
        const me = await fetch(`${server}/ext/me`, { headers: { authorization: `Bearer ${token}` } }).catch(() => null);
        if (me?.status === 401) {
          await browser.storage.local.remove(["token", "email"]);
          broadcastStatus();
          return;
        }
      }
      setTimeout(ensureSocket, retryMs);
      retryMs = Math.min(retryMs * 2, 30_000);
    };
  }

  async function routeFill(msg: Extract<ServerToExt, { type: "fill" }>) {
    await ready;
    const entry = forms.get(msg.formId);
    if (!entry) return; // another browser owns this form
    let res: FillResponse;
    try {
      res = (await browser.tabs.sendMessage(
        entry.tabId,
        { type: "fill", formId: msg.formId, answers: msg.answers, advance: msg.advance } satisfies BgMsg,
        { frameId: entry.frameId },
      )) as FillResponse;
      if (!Array.isArray(res?.results)) throw new Error("no response");
    } catch {
      res = { results: [{ fieldId: "*", label: "form", status: "failed", note: "The application tab was closed or reloaded. Reopen it and try again." }] };
      forms.delete(msg.formId);
      persist();
      wsSend({ type: "form_closed", formId: msg.formId });
    }
    wsSend({ type: "fill_result", requestId: msg.requestId, formId: msg.formId, results: res.results, advance: res.advance });
  }

  async function broadcastStatus() {
    const st = await status();
    for (const e of forms.values()) {
      browser.tabs.sendMessage(e.tabId, { type: "status", status: st } satisfies BgMsg, { frameId: e.frameId }).catch(() => undefined);
    }
  }

  function closeForm(formId: string) {
    if (!forms.delete(formId)) return;
    persist();
    wsSend({ type: "form_closed", formId });
  }

  function confirmSubmit(tabId: number, formId?: string) {
    const s = submits.get(tabId);
    if (!s || Date.now() - s.at > SUBMIT_WINDOW_MS || (formId && s.formId !== formId)) return;
    submits.delete(tabId);
    persist();
    wsSend({ type: "submitted", formId: s.formId, url: s.url, company: s.company, role: s.role, answers: s.answers });
  }

  // ---------- messages ----------

  browser.runtime.onMessage.addListener((msg: ContentMsg | PopupMsg, sender, sendResponse) => {
    const tabId = sender.tab?.id;
    const frameId = sender.frameId ?? 0;
    (async () => {
      await ready;
      switch (msg.type) {
        case "form":
          if (tabId == null) return;
          {
            if (pages.delete(msg.form.session)) persist();
            const prev = forms.get(msg.form.formId);
            const changed = !prev || JSON.stringify(prev.form.fields) !== JSON.stringify(msg.form.fields);
            forms.set(msg.form.formId, { tabId, frameId, form: msg.form });
            persist();
            if (ws?.readyState !== WebSocket.OPEN) ensureSocket();
            else if (changed) wsSend({ type: "form", form: msg.form });
          }
          return status();
        case "form_closed":
          closeForm(msg.formId);
          return;
        case "page":
          if (tabId == null) return;
          pages.set(msg.page.session, tabId);
          persist();
          wsSend({ type: "page", page: msg.page });
          return;
        case "page_closed":
          if (pages.delete(msg.session)) persist();
          wsSend({ type: "page_closed", session: msg.session });
          return;
        case "advance_blocked":
          wsSend({ type: "advance_blocked", formId: msg.formId, note: msg.note });
          return;
        case "connect":
          await connectAccount();
          return { ok: true };
        case "submit_attempt":
          if (tabId == null) return;
          submits.set(tabId, { ...msg, at: Date.now() });
          persist();
          return;
        case "submit_confirmed":
          if (tabId != null) confirmSubmit(tabId, msg.formId);
          return;
        case "success_page":
          if (tabId != null) confirmSubmit(tabId);
          return;
        case "status?":
          return status();
        case "popup:state": {
          const a = await auth();
          return {
            email: a.token ? a.email : undefined,
            server: a.server,
            connected: ws?.readyState === WebSocket.OPEN,
            allSites: await hasAllSites(),
            forms: [...forms.values()].map((e) => ({ company: e.form.company, role: e.form.role, fields: e.form.fields.length, step: e.form.step })),
          } satisfies PopupState;
        }
        case "popup:connect":
          await connectAccount();
          return { ok: true };
        case "popup:disconnect":
          await disconnectAccount();
          return { ok: true };
        case "popup:server":
          await browser.storage.local.set({ server: msg.server.replace(/\/+$/, "") });
          await disconnectAccount();
          return { ok: true };
        case "popup:allsites":
          await syncAllSites(msg.enabled && (await hasAllSites()));
          if (!msg.enabled) await browser.permissions.remove({ origins: ["<all_urls>"] }).catch(() => false);
          return { ok: true };
        case "popup:inject":
          await browser.scripting.executeScript({ target: { tabId: msg.tabId, allFrames: true }, files: ["/inject.js"] });
          return { ok: true };
      }
    })()
      .then(sendResponse)
      .catch((e) => sendResponse({ error: e instanceof Error ? e.message : String(e) }));
    return true;
  });

  browser.tabs.onRemoved.addListener(async (tabId) => {
    await ready;
    for (const [id, e] of forms) if (e.tabId === tabId) closeForm(id);
    for (const [sess, t] of pages) {
      if (t !== tabId) continue;
      pages.delete(sess);
      persist();
      wsSend({ type: "page_closed", session: sess });
    }
    if (submits.delete(tabId)) persist();
  });

  ensureSocket();
});
