// Content-script logic: capture the form (or note a job page that still needs "Apply"), keep the
// background informed, fill on request (optionally clicking Next), and detect a successful submit.

import type { AdvanceResult, CapturedForm, FillAnswer, FillResult, PageInfo } from "@job-copilot/shared";
import { browser } from "wxt/browser";
import {
  captureForm,
  describeButton,
  detectSite,
  findApplyTarget,
  findNextButton,
  findSubmitButton,
  formControlCount,
  formSignature,
  guessCompanyRole,
  ID_ATTR,
  invalidFieldLabels,
  jobPostingTitle,
} from "./capture";
import { fillForm, realClick } from "./fill";
import { Pill } from "./pill";

export type BgStatus = { signedIn: boolean; connected: boolean };

// Messages content → background
export type ContentMsg =
  | { type: "form"; form: CapturedForm }
  | { type: "form_closed"; formId: string }
  | { type: "page"; page: PageInfo }
  | { type: "page_closed"; session: string }
  | { type: "advance_blocked"; formId: string; note: string }
  | { type: "submit_attempt"; formId: string; url: string; company?: string; role?: string }
  | { type: "submit_confirmed"; formId: string }
  | { type: "success_page" }
  | { type: "status?" }
  | { type: "connect" };

// Messages background → content
export type BgMsg =
  | { type: "fill"; formId: string; answers: FillAnswer[]; advance?: boolean }
  | { type: "status"; status: BgStatus };

export interface FillResponse {
  results: FillResult[];
  advance?: AdvanceResult;
}

const SUCCESS_TEXT = /thank you for (applying|your application)|application (has been |was )?(submitted|received)|successfully (submitted|applied)|your response has been recorded|we('|’)ve received your application/i;
const SUBMIT_RE = /^(submit|send)\b|submit (my |your )?application|^finish$/i;

// One application in one tab keeps the same session across pages (sessionStorage survives
// full-page navigations within the site). A different job starts a new session.
interface SessionState {
  id: string;
  company?: string;
  role?: string;
  step: number;
  sig: string;
}
let memorySession: SessionState | null = null;
function loadSession(): SessionState | null {
  try {
    return JSON.parse(sessionStorage.getItem("jc-session") ?? "null") ?? memorySession;
  } catch {
    return memorySession;
  }
}
function saveSession(s: SessionState) {
  memorySession = s;
  try {
    sessionStorage.setItem("jc-session", JSON.stringify(s));
  } catch {
    // storage blocked (sandboxed frame): memory only
  }
}

// mode: "site" = known job site; "manual" = user clicked "Use on this page"; "lazy" = any site
// (only wakes up once the page has a form or a job posting).
export function runOnPage(mode: "site" | "manual" | "lazy" = "site") {
  const w = window as unknown as { __jobSeeker?: boolean };
  if (w.__jobSeeker) return;
  w.__jobSeeker = true;

  const isTop = window.top === window;
  let formId = crypto.randomUUID();
  let lastUrl = location.href;
  let current: CapturedForm | null = null;
  let status: BgStatus = { signedIn: false, connected: false };
  let pill: Pill | null = null;
  let filling = false;
  let submittedSent = false;
  let reportedPage = "";
  let lastFill: { filled: number; needs: number } | null = null;
  let needsIdx = 0;

  const send = (msg: ContentMsg) => browser.runtime.sendMessage(msg).catch(() => undefined);
  const getPill = () => (pill ??= new Pill());

  function session(meta: { company?: string; role?: string }): SessionState {
    let s = loadSession();
    const differentJob = s && ((meta.role && s.role && meta.role !== s.role) || (meta.company && s.company && meta.company !== s.company));
    if (!s || differentJob) s = { id: crypto.randomUUID(), company: meta.company, role: meta.role, step: 0, sig: "" };
    return s;
  }

  // ---------- pill ----------

  function jumpToNeeds() {
    const els = [...document.querySelectorAll<HTMLElement>(".jc-needs")];
    if (!els.length) return;
    const el = els[needsIdx++ % els.length]!;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.querySelector<HTMLElement>("input, textarea, select, button")?.focus({ preventScroll: true });
  }

  const connectAction = { label: "Connect", onClick: () => send({ type: "connect" }) };

  function render() {
    if (!current) return;
    const p = getPill();
    if (!status.signedIn) return p.show("JobSeeker isn't connected", "warn", { action: connectAction });
    if (filling) return;
    if (current.final) return p.show("Final page · review everything, then click Submit", "done");
    if (lastFill) {
      return lastFill.needs
        ? p.show(`Filled ${lastFill.filled} · ${lastFill.needs} ${lastFill.needs === 1 ? "needs" : "need"} you · review, then submit`, "done", { action: { label: "Next field ›", onClick: jumpToNeeds } })
        : p.show(`Filled ${lastFill.filled} · review, then submit`, "done");
    }
    const step = current.step > 1 ? `Page ${current.step} · ` : "";
    p.show(`${step}${current.fields.length} fields ready · ask your AI to “fill it”`, "ready");
  }

  // ---------- capture ----------

  async function capture() {
    if (location.href !== lastUrl) {
      // SPA navigation (e.g. next page of a multi-step form): new form id, same session
      if (current) send({ type: "form_closed", formId });
      formId = crypto.randomUUID();
      lastUrl = location.href;
      current = null;
      lastFill = null;
      submittedSent = false;
    }
    const site = detectSite();
    const meta = guessCompanyRole(site);
    const s = session(meta);
    let form = captureForm(formId, s.id, s.step || 1);
    // The review page of a multi-step application: no fields, just Submit. Report it so the
    // assistant knows to stop and hand over to the user.
    if (!form && s.step > 0 && findSubmitButton()) {
      form = { formId, session: s.id, step: s.step, url: location.href, site, ...meta, pageTitle: document.title, fields: [], capturedAt: Date.now(), final: true };
    }
    if (!form) return reportJobPage(s);
    const sig = form.final ? `final:${location.href}` : formSignature(form);
    if (sig !== s.sig) {
      // new questions: the next page/step of this application
      s.step = s.step + 1;
      s.sig = sig;
      s.company ??= form.company;
      s.role ??= form.role;
      saveSession(s);
      lastFill = null;
    }
    form.step = s.step;
    const changed = !current || (current.final ? `final:${current.url}` : formSignature(current)) !== sig;
    current = form;
    if (!changed) return;
    const reply = (await send({ type: "form", form })) as BgStatus | undefined;
    if (reply) status = reply;
    render();
  }

  // A job page without a form (yet): tell Claude and offer to open the application.
  function reportJobPage(s: SessionState) {
    if (!isTop || current) return;
    const apply = findApplyTarget();
    const posting = jobPostingTitle();
    if (!apply && !(mode !== "lazy" && posting)) return;
    const meta = guessCompanyRole(detectSite());
    const key = `${location.href}|${!!apply}`;
    if (key !== reportedPage) {
      reportedPage = key;
      saveSession(s);
      send({
        type: "page",
        page: {
          session: s.id,
          url: location.href,
          title: document.title,
          site: detectSite(),
          company: meta.company,
          role: posting || meta.role,
          applyLink: apply instanceof HTMLAnchorElement && apply.href.startsWith("http") ? apply.href : undefined,
          hasApplyButton: !!apply,
          seenAt: Date.now(),
        },
      });
    }
    if (apply) getPill().show("Ready to apply?", "ready", { action: { label: "Open application", onClick: () => realClick(apply) } });
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (ms = 600) => {
    clearTimeout(timer);
    timer = setTimeout(capture, ms);
  };

  function start() {
    new MutationObserver((mutations) => {
      if (filling) return;
      if (mutations.every((m) => (m.target as Element).closest?.("[data-jc-ui]"))) return;
      schedule();
    }).observe(document.documentElement, { childList: true, subtree: true });
    schedule(mode === "manual" ? 0 : 300);
    // Re-announce now and then so a restarted background worker learns about the form again.
    setInterval(() => {
      if (current) send({ type: "form", form: { ...current, fields: captureForm(formId, current.session, current.step)?.fields ?? current.fields } });
    }, 25_000);
  }

  if (mode === "lazy") {
    // Any website: stay idle until the page has a form or a job posting.
    let started = false;
    const check = () => {
      if (started) return;
      if (formControlCount() >= 3 || jobPostingTitle()) {
        started = true;
        start();
      }
    };
    check();
    const iv = setInterval(check, 2000);
    setTimeout(() => clearInterval(iv), 60_000);
    document.addEventListener("click", () => setTimeout(check, 800), true);
  } else {
    start();
  }

  // ---------- fill ----------

  browser.runtime.onMessage.addListener((msg: BgMsg, _sender, sendResponse) => {
    if (msg.type === "status") {
      status = msg.status;
      render();
      return;
    }
    if (msg.type === "fill" && current && msg.formId === formId) {
      const form = current;
      filling = true;
      getPill().show(`Filling 0/${msg.answers.length}…`, "working", { force: true, progress: 0 });
      fillForm(form.site, form.fields, msg.answers, (done, total) =>
        getPill().show(`Filling ${done + 1}/${total}…`, "working", { force: true, progress: (done + 1) / total }),
      )
        .then((results) => {
          filling = false;
          const filled = results.filter((r) => r.status === "filled").length;
          lastFill = { filled, needs: results.length - filled };
          needsIdx = 0;
          if (!msg.advance) {
            render();
            sendResponse({ results } satisfies FillResponse);
            setTimeout(() => capture(), 400); // pick up conditional questions the answers revealed
            return;
          }
          advance(form, results, sendResponse);
        })
        .catch((e) => {
          filling = false;
          sendResponse({ results: [{ fieldId: "*", label: "form", status: "failed", note: String(e) }] } satisfies FillResponse);
        });
      return true; // async response
    }
  });

  // Click Next/Continue after filling: answer first (a full-page navigation would cut us off),
  // then click, then report if the page refused to advance.
  function advance(form: CapturedForm, results: FillResult[], sendResponse: (r: FillResponse) => void) {
    const byId = new Map(form.fields.map((f) => [f.id, f]));
    const blocking = results.filter((r) => r.status !== "filled" && byId.get(r.fieldId)?.required);
    if (blocking.length) {
      sendResponse({
        results,
        advance: {
          clicked: false,
          note: `Not moving on yet: required fields need the user (${blocking.map((b) => b.label).join(", ")}). Tell them; once they're done the extension continues to the next page by itself. Call wait_for_next_page to pick it up.`,
        },
      });
      watchUntilFixed(form, blocking.map((b) => b.fieldId));
      return;
    }
    clickNext(form, results, sendResponse);
  }

  // After a blocked advance: wait for the user to fix the required fields, then continue by itself.
  function watchUntilFixed(form: CapturedForm, ids: string[]) {
    const labels = new Map(form.fields.map((f) => [f.id, f.label]));
    getPill().show(`Needs you: ${ids.map((i) => labels.get(i)).join(", ")} · then I'll continue`, "warn", { force: true, action: { label: "Show ›", onClick: jumpToNeeds } });
    const started = Date.now();
    const iv = setInterval(() => {
      const now = captureForm(formId, form.session, form.step);
      if (!now || location.href !== form.url || Date.now() - started > 15 * 60_000) return clearInterval(iv); // moved on or gave up
      const byId = new Map(now.fields.map((f) => [f.id, f]));
      if (!ids.every((i) => byId.get(i)?.hasValue)) return;
      clearInterval(iv);
      let cancelled = false;
      getPill().show("All set · continuing to the next page…", "working", { force: true, progress: 1, action: { label: "Wait", onClick: () => (cancelled = true) } });
      setTimeout(() => {
        if (cancelled) return render();
        clickNext(form, [], null);
      }, 3000);
    }, 1000);
  }

  function clickNext(form: CapturedForm, results: FillResult[], sendResponse: ((r: FillResponse) => void) | null) {
    const btn = findNextButton();
    if (!btn) {
      render();
      return sendResponse?.({ results, advance: { clicked: false, note: "No Next/Continue button on this page. It may be the last page: the user reviews and clicks Submit." } });
    }
    const label = describeButton(btn);
    sendResponse?.({ results, advance: { clicked: true, button: label } });
    getPill().show(`Filled ${results.filter((r) => r.status === "filled").length} · moving to the next page…`, "working", { force: true, progress: 1 });
    const urlBefore = location.href;
    const sigBefore = formSignature(form);
    setTimeout(() => {
      realClick(btn);
      setTimeout(() => {
        const now = captureForm(formId, form.session, form.step);
        if (location.href === urlBefore && now && formSignature(now) === sigBefore) {
          const invalid = invalidFieldLabels();
          const note = invalid.length ? `Clicked "${label}" but the page didn't advance; it flags: ${invalid.join(", ")}.` : `Clicked "${label}" but the page didn't advance.`;
          send({ type: "advance_blocked", formId, note });
          render();
        }
      }, 3500);
    }, 50);
  }

  // ---------- submit detection ----------

  // The background remembers the attempt; it is confirmed either here (single-page apps) or by
  // the thank-you page that loads next in the same tab (full-page submits).
  function onSubmitAttempt() {
    if (!current || submittedSent) return;
    const snapshot = { form: current, id: formId };
    send({ type: "submit_attempt", formId, url: current.url, company: current.company, role: current.role });
    let checks = 0;
    const check = () => {
      checks++;
      const formGone = !document.querySelector(`[${ID_ATTR}]`);
      const success = SUCCESS_TEXT.test(document.body.innerText.slice(0, 20000)) || formGone || location.href !== snapshot.form.url;
      if (success && !submittedSent) {
        submittedSent = true;
        send({ type: "submit_confirmed", formId: snapshot.id });
        getPill().show("Submitted · marked Applied in your tracker", "done", { force: true });
      } else if (checks < 8) {
        setTimeout(check, 1500);
      }
    };
    setTimeout(check, 1500);
  }

  setTimeout(() => {
    if (SUCCESS_TEXT.test(document.body?.innerText.slice(0, 20000) ?? "")) send({ type: "success_page" });
  }, 1500);

  document.addEventListener(
    "submit",
    (e) => {
      // a <form> submit caused by "Next"/"Continue" on a multi-step form isn't the final submit
      const by = (e as SubmitEvent).submitter;
      if (by && !SUBMIT_RE.test(describeButton(by))) return;
      onSubmitAttempt();
    },
    true,
  );
  document.addEventListener(
    "click",
    (e) => {
      if (!e.isTrusted) return; // our own clicks (Next) are not submits
      const btn = (e.target as Element).closest?.("button, input[type=submit], [role=button]");
      if (btn && SUBMIT_RE.test(describeButton(btn))) onSubmitAttempt();
    },
    true,
  );

  window.addEventListener("pagehide", () => {
    if (current && !submittedSent) send({ type: "form_closed", formId });
  });
}
