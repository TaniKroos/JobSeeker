// One UserRoom per user. It holds the live WebSocket(s) from that user's extension, the
// application forms and job pages the extension sees, and relays Claude's fill requests to the
// right tab. Multi-step forms share a `session`; each new page bumps `step`.

import { DurableObject } from "cloudflare:workers";
import type { AdvanceResult, CapturedForm, ExtToServer, FillAnswer, FillResult, PageInfo, ServerToExt } from "@job-copilot/shared";
import { PING, PONG } from "@job-copilot/shared";
import { upsertApplication, type User } from "./db";

// Open forms and job pages are only needed while the user is applying.
const FORM_TTL_MS = 60 * 60 * 1000;
const PAGE_TTL_MS = 60 * 60 * 1000;
const FILL_TIMEOUT_MS = 50_000; // long forms with many dropdowns take a while
const NEXT_PAGE_AFTER_ADVANCE_MS = 20_000;

export interface FormRecord {
  form: CapturedForm;
  updatedAt: number;
  lastFill?: { at: number; results: FillResult[] };
}

export interface FillOutcome {
  delivered: boolean;
  results?: FillResult[];
  advance?: AdvanceResult;
  nextForm?: FormRecord | null;
  error?: string;
}

interface NextWaiter {
  session: string;
  afterFormId: string;
  afterStep: number;
  resolve: (rec: FormRecord | null, note?: string) => void;
}

export class UserRoom extends DurableObject<Env> {
  // In memory: the object stays awake while an RPC call is awaiting these.
  private fillWaiters = new Map<string, (r: { results: FillResult[]; advance?: AdvanceResult }) => void>();
  private nextWaiters = new Set<NextWaiter>();
  private blocked = new Map<string, string>(); // formId → why Next didn't advance (in memory)

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Keep-alive pings are answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  // The Worker has already authenticated the extension token before forwarding the upgrade.
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });
    const user: User = JSON.parse(request.headers.get("X-JC-User") ?? "null");
    if (!user?.id) return new Response("Missing user", { status: 400 });
    await this.ctx.storage.put("user", user);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    this.send(server, { type: "hello", email: user.email });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string") return;
    let msg: ExtToServer;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    switch (msg.type) {
      case "form":
        await this.onForm(msg.form);
        break;
      case "form_closed":
        await this.ctx.storage.delete(`form:${msg.formId}`);
        break;
      case "page":
        await this.ctx.storage.put(`page:${msg.page.session}`, msg.page);
        await this.scheduleCleanup();
        break;
      case "page_closed":
        await this.ctx.storage.delete(`page:${msg.session}`);
        break;
      case "advance_blocked": {
        // Next was clicked but the page refused (validation errors): stop anyone waiting for the next page.
        const rec = await this.ctx.storage.get<FormRecord>(`form:${msg.formId}`);
        for (const w of this.nextWaiters) {
          if (w.afterFormId === msg.formId || (rec && w.session === rec.form.session)) {
            this.nextWaiters.delete(w);
            w.resolve(null, msg.note);
          }
        }
        this.blocked.set(msg.formId, msg.note);
        break;
      }
      case "fill_result": {
        const rec = await this.ctx.storage.get<FormRecord>(`form:${msg.formId}`);
        if (rec) {
          rec.lastFill = { at: Date.now(), results: msg.results };
          await this.ctx.storage.put(`form:${msg.formId}`, rec);
        }
        this.fillWaiters.get(msg.requestId)?.({ results: msg.results, advance: msg.advance });
        break;
      }
      case "submitted":
        await this.onSubmitted(msg);
        break;
    }
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try {
      ws.close(code, "closing");
    } catch {
      // already closed
    }
  }

  private async onForm(form: CapturedForm): Promise<void> {
    const prev = await this.ctx.storage.get<FormRecord>(`form:${form.formId}`);
    const rec: FormRecord = { form, updatedAt: Date.now(), lastFill: prev?.form.step === form.step ? prev?.lastFill : undefined };
    // A new page of the same application replaces the older pages.
    if (form.session) {
      const all = await this.ctx.storage.list<FormRecord>({ prefix: "form:" });
      for (const [key, other] of all) {
        if (other.form.session === form.session && other.form.formId !== form.formId) {
          await this.ctx.storage.delete(key);
          await this.ctx.storage.put(`moved:${other.form.formId}`, { to: form.formId, at: Date.now() }); // for waitForNext on the old id
        }
      }
      await this.ctx.storage.delete(`page:${form.session}`);
    }
    await this.ctx.storage.put(`form:${form.formId}`, rec);
    await this.scheduleCleanup();
    for (const w of this.nextWaiters) {
      if (w.session === form.session && (form.formId !== w.afterFormId || form.step > w.afterStep)) {
        this.nextWaiters.delete(w);
        w.resolve(rec);
      }
    }
  }

  private async onSubmitted(msg: Extract<ExtToServer, { type: "submitted" }>): Promise<void> {
    const user = await this.ctx.storage.get<User>("user");
    if (!user) return;
    const rec = await this.ctx.storage.get<FormRecord>(`form:${msg.formId}`);
    const company = msg.company || rec?.form.company;
    const role = msg.role || rec?.form.role;
    if (company && role) {
      await upsertApplication(this.env.DB, user.id, { company, role, url: msg.url, status: "Applied" });
    }
    await this.ctx.storage.delete(`form:${msg.formId}`);
  }

  // ---------- cleanup ----------

  // Wipe everything that has expired an hour after the last activity, even if no one calls us again.
  private async scheduleCleanup() {
    const at = Date.now() + FORM_TTL_MS + 60_000;
    const current = await this.ctx.storage.getAlarm();
    if (!current || current < at - 5 * 60_000) await this.ctx.storage.setAlarm(at);
  }

  async alarm(): Promise<void> {
    const cutoff = Date.now() - FORM_TTL_MS;
    const all = await this.ctx.storage.list<{ updatedAt?: number; seenAt?: number; at?: number }>();
    const expired: string[] = [];
    for (const [key, v] of all) {
      if (key === "user") continue;
      const t = v?.updatedAt ?? v?.seenAt ?? v?.at ?? 0;
      if (t < cutoff) expired.push(key);
    }
    for (let i = 0; i < expired.length; i += 128) await this.ctx.storage.delete(expired.slice(i, i + 128));
    if (expired.length < all.size - 1) await this.scheduleCleanup(); // something is still live
  }

  // ---------- called by MCP tools (RPC) ----------

  async status(): Promise<{ extensionConnected: boolean; openForms: number }> {
    const forms = await this.getForms();
    return { extensionConnected: this.ctx.getWebSockets().length > 0, openForms: forms.length };
  }

  async getForms(): Promise<FormRecord[]> {
    const all = await this.ctx.storage.list<FormRecord>({ prefix: "form:" });
    const fresh: FormRecord[] = [];
    for (const [key, rec] of all) {
      if (Date.now() - rec.updatedAt > FORM_TTL_MS) await this.ctx.storage.delete(key);
      else fresh.push(rec);
    }
    return fresh.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  // Job pages open without a form (e.g. a description page where the user still has to click Apply).
  async getPages(): Promise<PageInfo[]> {
    const all = await this.ctx.storage.list<PageInfo>({ prefix: "page:" });
    const fresh: PageInfo[] = [];
    for (const [key, p] of all) {
      if (Date.now() - p.seenAt > PAGE_TTL_MS) await this.ctx.storage.delete(key);
      else fresh.push(p);
    }
    return fresh.sort((a, b) => b.seenAt - a.seenAt);
  }

  async getForm(formId: string): Promise<FormRecord | null> {
    return (await this.ctx.storage.get<FormRecord>(`form:${formId}`)) ?? null;
  }

  // Resolves with the next page/step of the same application, or null after the timeout.
  async waitForNext(formId: string, timeoutMs: number): Promise<FormRecord | null> {
    const rec = await this.getForm(formId);
    if (!rec) {
      // the page already moved on: follow the chain to the page that replaced it
      let id: string | undefined = formId;
      for (let i = 0; i < 20 && id; i++) {
        id = (await this.ctx.storage.get<{ to: string }>(`moved:${id}`))?.to;
        const current = id ? await this.getForm(id) : null;
        if (current) return current;
      }
      return null;
    }
    return this.waitForSession(rec.form.session, formId, rec.form.step, timeoutMs);
  }

  private async waitForSession(session: string, formId: string, step: number, timeoutMs: number): Promise<FormRecord | null> {
    return (await this.waitForSessionNote(session, formId, step, timeoutMs)).rec;
  }

  private async waitForSessionNote(session: string, formId: string, step: number, timeoutMs: number): Promise<{ rec: FormRecord | null; note?: string }> {
    const newer = (await this.getForms()).find((f) => f.form.session === session && (f.form.formId !== formId || f.form.step > step));
    if (newer) return { rec: newer };
    return new Promise((resolve) => {
      const w: NextWaiter = { session, afterFormId: formId, afterStep: step, resolve: (rec, note) => resolve({ rec, note }) };
      this.nextWaiters.add(w);
      setTimeout(() => {
        if (this.nextWaiters.delete(w)) resolve({ rec: null });
      }, timeoutMs);
    });
  }

  async fill(formId: string, answers: FillAnswer[], advance = false): Promise<FillOutcome> {
    const rec = await this.getForm(formId);
    if (!rec) return { delivered: false, error: "That form is no longer open (the page changed or was closed). Call get_open_forms to see the current page." };
    const sockets = this.ctx.getWebSockets();
    if (!sockets.length) {
      return {
        delivered: false,
        error: "The browser extension is not connected. Ask the user to keep the application tab open and check the extension is signed in.",
      };
    }
    const requestId = crypto.randomUUID();
    const { session, step } = rec.form;
    const result = new Promise<{ results: FillResult[]; advance?: AdvanceResult } | null>((resolve) => {
      const timer = setTimeout(() => {
        this.fillWaiters.delete(requestId);
        resolve(null);
      }, FILL_TIMEOUT_MS);
      this.fillWaiters.set(requestId, (r) => {
        clearTimeout(timer);
        this.fillWaiters.delete(requestId);
        resolve(r);
      });
    });
    // Every connected browser gets it; only the one that owns this form fills it.
    for (const ws of sockets) this.send(ws, { type: "fill", requestId, formId, answers, advance });
    const r = await result;
    if (!r) return { delivered: true, error: "Sent to the browser, but it did not confirm in time. Ask the user to check the page." };
    let nextForm: FormRecord | null | undefined;
    let adv = r.advance;
    if (adv?.clicked) {
      this.blocked.delete(formId);
      const waited = await this.waitForSessionNote(session, formId, step, NEXT_PAGE_AFTER_ADVANCE_MS);
      nextForm = waited.rec;
      const note = waited.note ?? this.blocked.get(formId);
      if (!nextForm && note) adv = { clicked: false, button: adv.button, note };
    }
    return { delivered: true, results: r.results, advance: adv, nextForm };
  }

  private send(ws: WebSocket, msg: ServerToExt) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // socket closing; the extension will reconnect
    }
  }
}
