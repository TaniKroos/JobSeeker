// Put Claude's answers into the page's form controls, the way a user would, and highlight them.

import type { FillAnswer, FillResult, FormField } from "@job-copilot/shared";
import { ID_ATTR } from "./capture";

const norm = (s: string | null | undefined) =>
  (s ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[*.:]+$/, "")
    .trim();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Poll until fn returns something truthy (or time runs out) instead of sleeping a fixed time.
async function poll<T>(fn: () => T | null | undefined | false, timeoutMs: number, everyMs = 50): Promise<T | null> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() >= end) return null;
    await sleep(everyMs);
  }
}

// Pick the option that best matches the wanted value: exact, then the option starting with the
// value at a word boundary ("Bangalore" → "Bangalore, Karnataka"), then the value starting with
// the option ("Yes, I am" → "Yes"). Never a bare substring: "Yes" must not pick "Yessentuki".
const boundaryPrefix = (long: string, short: string) => !!short && long.startsWith(short) && (long.length === short.length || /[^a-z0-9]/.test(long[short.length]!));

function bestMatch<T>(items: T[], text: (t: T) => string, wanted: string): T | undefined {
  const w = norm(wanted);
  if (!w) return undefined;
  return (
    items.find((i) => norm(text(i)) === w) ??
    items.find((i) => boundaryPrefix(norm(text(i)), w)) ??
    items.find((i) => boundaryPrefix(w, norm(text(i))))
  );
}

// React/Vue track input values through the native setter; assigning .value directly is ignored.
function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  el.focus();
  setter ? setter.call(el, value) : (el.value = value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  el.dispatchEvent(new Event("blur", { bubbles: true }));
}

function labelFor(input: HTMLInputElement): string {
  if (input.id) {
    const lbl = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
    if (lbl?.textContent) return lbl.textContent;
  }
  return input.closest("label")?.textContent ?? input.getAttribute("aria-label") ?? input.value;
}

export function realClick(el: HTMLElement) {
  el.scrollIntoView({ block: "nearest" });
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
  }
  el.click();
}

// ---------- highlight ----------

const STYLE_ID = "jc-fill-style";
function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
    .jc-filled{outline:2px solid #e3b400 !important;outline-offset:2px !important;background-color:rgba(255,214,0,.12) !important;transition:background-color .6s}
    .jc-needs{outline:2px solid #e5484d !important;outline-offset:2px !important}`;
  document.head.appendChild(s);
}

function mark(el: Element | null | undefined, cls: "jc-filled" | "jc-needs") {
  if (!el) return;
  const target = (el.closest("[role=listitem]") as HTMLElement) ?? (el as HTMLElement);
  target.classList.remove("jc-filled", "jc-needs");
  target.classList.add(cls);
}

// ---------- per-kind fillers ----------

type Outcome = { ok: boolean; note?: string; el?: Element | null };

async function fillGeneric(field: FormField, value: string | string[]): Promise<Outcome> {
  const els = [...document.querySelectorAll<HTMLElement>(`[${ID_ATTR}="${CSS.escape(field.id)}"]`)];
  const el = els[0];
  if (!el) return { ok: false, note: "Field is no longer on the page" };
  const v = Array.isArray(value) ? value.join(", ") : value;

  if (field.kind === "file") return { ok: false, note: "Upload this file yourself", el };

  if (el instanceof HTMLSelectElement) {
    const opt = bestMatch([...el.options], (o) => o.text, v) ?? [...el.options].find((o) => norm(o.value) === norm(v));
    if (!opt) return { ok: false, note: `No option matching "${v}"`, el };
    el.value = opt.value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, el };
  }

  if (el.getAttribute("role") === "combobox") return fillCombobox(el, v);

  if (el instanceof HTMLButtonElement) {
    const hit = bestMatch(els, (b) => b.textContent ?? "", v);
    if (!hit) return { ok: false, note: `No option matching "${v}"`, el: el.parentElement };
    realClick(hit);
    return { ok: true, el: el.parentElement };
  }

  if (el instanceof HTMLInputElement && (el.type === "radio" || el.type === "checkbox")) {
    const inputs = els as HTMLInputElement[];
    const wanted = Array.isArray(value) ? value : [value];
    const first = wanted[0] ?? "";
    if (el.type === "radio") {
      const target = bestMatch(inputs, labelFor, first);
      if (!target) return { ok: false, note: `No option matching "${first}"`, el };
      if (!target.checked) realClick(target);
      return { ok: true, el: target.closest("fieldset") ?? target.parentElement };
    }
    let missing: string[] = [];
    for (const w of wanted) {
      const target = bestMatch(inputs, labelFor, w);
      if (!target) missing.push(w);
      else if (!target.checked) realClick(target);
    }
    // a single consent checkbox answered "yes"/"true"
    const only = inputs.length === 1 ? inputs[0] : undefined;
    if (only && missing.length && /^(yes|true|agree|i agree|checked)$/i.test(first)) {
      if (!only.checked) realClick(only);
      missing = [];
    }
    return missing.length ? { ok: false, note: `No option matching "${missing.join(", ")}"`, el } : { ok: true, el: el.closest("fieldset") ?? el.parentElement };
  }

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    if (el.maxLength > 0 && v.length > el.maxLength) return { ok: false, note: `Answer is longer than ${el.maxLength} characters`, el };
    setNativeValue(el, v);
    if (el instanceof HTMLInputElement) {
      const picked = await pickSuggestion(el, v);
      if (picked) return picked;
    }
    return { ok: el.value === v, note: el.value === v ? undefined : "The page rejected the value", el };
  }
  return { ok: false, note: "Unsupported field", el };
}

const visibleText = (o: HTMLElement) => o.offsetParent !== null && !!o.textContent?.trim();

// Option elements for a dropdown/autocomplete: its own list, the area around it, or any open listbox
// (many libraries render the list in a portal at the end of <body>).
function suggestionsFor(input: HTMLElement, selector: string, container?: HTMLElement): HTMLElement[] {
  const listId = input.getAttribute("aria-controls") ?? input.getAttribute("aria-owns");
  const list = listId ? document.getElementById(listId) : null;
  let near: HTMLElement | null = container ?? input;
  for (let i = 0; i < 3 && !container && near?.parentElement; i++) near = near.parentElement;
  const scopes: ParentNode[] = [list, near, ...document.querySelectorAll<HTMLElement>("[role=listbox]")].filter(Boolean) as ParentNode[];
  for (const scope of scopes) {
    const opts = [...scope.querySelectorAll<HTMLElement>(selector)].filter(visibleText);
    if (opts.length) return opts;
  }
  return [];
}

// Typing via the value setter doesn't fire key events; some sites only search on keyup.
function nudgeKeys(input: HTMLElement) {
  input.focus();
  for (const type of ["keydown", "keypress", "input", "keyup"]) {
    input.dispatchEvent(
      type === "input" ? new Event("input", { bubbles: true }) : new KeyboardEvent(type, { key: "e", keyCode: 69, which: 69, bubbles: true } as KeyboardEventInit),
    );
  }
}

const listOf = (opts: HTMLElement[]) => opts.map((o) => (o.textContent ?? "").trim()).slice(0, 15).join(" | ");

// Autocomplete text inputs (locations, schools): typing shows suggestions; pick the matching one.
const SUGGESTION = "[role=option], .dropdown-results > *, .pac-item, li[class*='option' i], li[class*='suggestion' i], [class*='suggestion' i] li";

async function pickSuggestion(input: HTMLInputElement, v: string): Promise<Outcome | null> {
  const autocomplete = input.getAttribute("aria-autocomplete") || input.getAttribute("list") || input.getAttribute("aria-controls") || /location|autocomplete|typeahead/i.test(`${input.className} ${input.name}`);
  if (!autocomplete) return null;
  // some sites validate on blur and clear unselected text; put it back, then "type"
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, v);
  nudgeKeys(input);
  let last: HTMLElement[] = [];
  let stable = 0;
  const end = Date.now() + 3000; // suggestions usually come from the network
  while (Date.now() < end) {
    await sleep(100);
    const options = suggestionsFor(input, SUGGESTION);
    if (!options.length) continue;
    stable = listOf(options) === listOf(last) ? stable + 1 : 0;
    last = options;
    const hit = bestMatch(options, (o) => o.textContent ?? "", v);
    if (hit) {
      const chosen = (hit.textContent ?? "").trim();
      realClick(hit);
      await sleep(60);
      return { ok: true, el: input, note: norm(chosen) === norm(v) ? undefined : `Selected "${chosen}"` };
    }
    if (stable >= 5) break; // list settled without a match
  }
  if (!last.length) return null;
  setNativeValue(input, "");
  return { ok: false, el: input, note: `No suggestion matching "${v}". Suggestions: ${listOf(last)}` };
}

// Custom dropdown: type to filter, then click the matching option.
async function fillCombobox(input: HTMLElement, v: string): Promise<Outcome> {
  const container = (input.closest("[class*='container' i]") as HTMLElement) ?? input.parentElement!;
  // open it once without typing to see the full option list (used in the error message)
  realClick((container.querySelector("[class*='control' i]") as HTMLElement) ?? input);
  let seen = (await poll(() => { const o = suggestionsFor(input, "[role=option]", container); return o.length ? o : null; }, 400, 40)) ?? [];
  // fast path: the option is already in the open list
  const direct = bestMatch(seen, (o) => o.textContent ?? "", v);
  if (direct) {
    const chosen = (direct.textContent ?? "").trim();
    realClick(direct);
    await sleep(30);
    return { ok: true, el: container, note: norm(chosen) === norm(v) ? undefined : `Selected "${chosen}"` };
  }
  if (input instanceof HTMLInputElement) {
    setNativeValue(input, v);
    nudgeKeys(input);
  }
  let stable = 0;
  const end = Date.now() + 2000;
  while (Date.now() < end) {
    await sleep(80);
    const options = suggestionsFor(input, "[role=option]", container);
    // give up early once the filtered list has settled without a match
    stable = options.length && listOf(options) === listOf(seen) ? stable + 1 : 0;
    if (options.length) seen = options;
    if (stable >= 4) break;
    const hit = bestMatch(options, (o) => o.textContent ?? "", v);
    if (hit) {
      const chosen = (hit.textContent ?? "").trim();
      realClick(hit);
      await sleep(30);
      return { ok: true, el: container, note: norm(chosen) === norm(v) ? undefined : `Selected "${chosen}"` };
    }
  }
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  if (input instanceof HTMLInputElement) setNativeValue(input, "");
  return { ok: false, note: seen.length ? `No option matching "${v}". Options: ${listOf(seen)}` : `No option matching "${v}" in this dropdown`, el: container };
}

async function fillGoogle(field: FormField, value: string | string[]): Promise<Outcome> {
  const item = document.querySelector<HTMLElement>(`[${ID_ATTR}="${CSS.escape(field.id)}"]`);
  if (!item) return { ok: false, note: "Question is no longer on the page" };
  const wanted = Array.isArray(value) ? value : [value];
  const first = wanted[0] ?? "";
  const optText = (o: HTMLElement) => o.getAttribute("data-value") ?? o.getAttribute("data-answer-value") ?? o.getAttribute("aria-label") ?? o.textContent ?? "";

  if (field.kind === "radio") {
    const hit = bestMatch([...item.querySelectorAll<HTMLElement>("[role=radio]")], optText, first);
    if (!hit) return { ok: false, note: `No option matching "${first}"`, el: item };
    if (hit.getAttribute("aria-checked") !== "true") realClick(hit);
    return { ok: true, el: item };
  }
  if (field.kind === "checkbox") {
    const boxes = [...item.querySelectorAll<HTMLElement>("[role=checkbox]")];
    const missing = [];
    for (const w of wanted) {
      const hit = bestMatch(boxes, optText, w);
      if (!hit) missing.push(w);
      else if (hit.getAttribute("aria-checked") !== "true") realClick(hit);
    }
    return { ok: !missing.length, note: missing.length ? `No option matching "${missing.join(", ")}"` : undefined, el: item };
  }
  if (field.kind === "select") {
    const listbox = item.querySelector<HTMLElement>("[role=listbox]");
    if (!listbox) return { ok: false, note: "Dropdown not found", el: item };
    realClick(listbox);
    const hit = await poll(() => {
      const opts = [...document.querySelectorAll<HTMLElement>("[role=option]")].filter((o) => item.contains(o) || o.closest("[role=presentation]"));
      return bestMatch(opts, optText, first);
    }, 1500);
    if (hit) {
      realClick(hit);
      await sleep(150);
      return { ok: true, el: item };
    }
    return { ok: false, note: `Could not pick "${first}"`, el: item };
  }
  const box = item.querySelector<HTMLTextAreaElement | HTMLInputElement>("textarea, input:not([type=hidden])");
  if (!box) return { ok: false, note: "Input not found", el: item };
  setNativeValue(box, wanted.join(", "));
  return { ok: true, el: item };
}

// ---------- entry ----------

export async function fillForm(
  site: string,
  fields: FormField[],
  answers: FillAnswer[],
  onProgress?: (done: number, total: number) => void,
): Promise<FillResult[]> {
  ensureStyle();
  const byId = new Map(fields.map((f) => [f.id, f]));
  const results: FillResult[] = [];
  let firstNeeds: Element | null = null;

  let done = 0;
  for (const a of answers) {
    onProgress?.(done++, answers.length);
    const field = byId.get(a.fieldId);
    if (!field) {
      results.push({ fieldId: a.fieldId, label: "?", status: "failed", note: "Unknown field id" });
      continue;
    }
    let out: Outcome;
    try {
      out = site === "google-forms" ? await fillGoogle(field, a.value) : await fillGeneric(field, a.value);
    } catch (e) {
      out = { ok: false, note: e instanceof Error ? e.message : "Error" };
    }
    mark(out.el, out.ok ? "jc-filled" : "jc-needs");
    if (!out.ok && !firstNeeds) firstNeeds = out.el ?? null;
    results.push({ fieldId: field.id, label: field.label, status: out.ok ? "filled" : field.kind === "file" ? "needs_user" : "failed", ...(out.note ? { note: out.note } : {}) });
  }

  // Fields Claude did not answer that are required (e.g. resume upload) still need the user.
  const answered = new Set(answers.map((a) => a.fieldId));
  for (const f of fields) {
    if (answered.has(f.id) || !f.required) continue;
    const hasValue = Array.isArray(f.value) ? f.value.length > 0 : !!f.value?.trim();
    if (hasValue) continue;
    const el = document.querySelector(`[${ID_ATTR}="${CSS.escape(f.id)}"]`);
    mark(f.kind === "file" ? el?.parentElement : el, "jc-needs");
    if (!firstNeeds) firstNeeds = el;
    results.push({ fieldId: f.id, label: f.label, status: "needs_user", note: f.kind === "file" ? "Upload this file yourself" : "Required and not answered" });
  }

  (firstNeeds as HTMLElement | null)?.scrollIntoView({ behavior: "smooth", block: "center" });
  return results;
}
