// Read the application form on the page into a list of fields Claude can answer.
// Every captured control gets a data-jc-id attribute so fill.ts can find it again.

import type { CapturedForm, FormField } from "@job-copilot/shared";

export const ID_ATTR = "data-jc-id";

// Lever marks required questions with "✱" and puts hidden error text after it.
const clean = (s: string | null | undefined) =>
  (s ?? "")
    .split("✱")[0]!
    .replace(/\s+/g, " ")
    .replace(/\s*\*\s*$/, "")
    .replace(/\(required\)/i, "")
    .trim();

const textOf = (el: Element | null | undefined) => clean((el as HTMLElement | null)?.innerText ?? el?.textContent);

function isVisible(el: Element): boolean {
  const h = el as HTMLElement;
  if (h.closest("[aria-hidden='true']") && !(h instanceof HTMLInputElement && h.type === "file")) return false;
  const style = getComputedStyle(h);
  if (style.display === "none" || style.visibility === "hidden") return false;
  return h.getClientRects().length > 0;
}

// Visible text of a label element, without the text of controls nested inside it.
function labelText(label: Element): string {
  if (!label.querySelector("input, select, textarea, [role=listbox], [role=option]")) {
    const visible = textOf(label);
    if (visible) return visible;
  }
  const copy = label.cloneNode(true) as HTMLElement;
  copy.querySelectorAll("input, select, textarea, [role=listbox], [role=option]").forEach((n) => n.remove());
  return textOf(copy) || clean(copy.textContent);
}

function byIds(ids: string | null): string {
  if (!ids) return "";
  return ids
    .split(/\s+/)
    .map((id) => textOf(document.getElementById(id)))
    .filter(Boolean)
    .join(" ");
}

// Best-effort question text for a control.
function questionFor(el: HTMLElement): string {
  const labelledBy = byIds(el.getAttribute("aria-labelledby"));
  if (labelledBy) return labelledBy;
  if (el.id) {
    const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (lbl && labelText(lbl)) return labelText(lbl);
  }
  const wrap = el.closest("label");
  if (wrap && labelText(wrap)) return labelText(wrap);
  const aria = clean(el.getAttribute("aria-label"));
  if (aria) return aria;
  return containerQuestion(el) || clean(el.getAttribute("placeholder")) || humanize(el.getAttribute("name"));
}

// Walk up a few levels looking for a label/legend/heading-like element that precedes the control.
function containerLabel(el: HTMLElement): Element | null {
  let node: HTMLElement | null = el.parentElement;
  for (let depth = 0; node && depth < 5; depth++, node = node.parentElement) {
    const legend = node.querySelector(":scope > legend, :scope > label, :scope > .application-label, :scope > [class*='label' i]");
    if (legend && !legend.contains(el) && labelText(legend)) return legend;
    if (node.tagName === "FIELDSET") {
      const lg = node.querySelector("legend");
      if (lg && textOf(lg)) return lg;
    }
    if (node.tagName === "FORM") break;
  }
  return null;
}

function containerQuestion(el: HTMLElement): string {
  const lbl = containerLabel(el);
  return lbl ? labelText(lbl) : "";
}

const humanize = (name: string | null) =>
  clean((name ?? "").replace(/[_\-\[\]]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2"));

// Group question for a set of radios/checkboxes sharing a name.
function groupQuestion(inputs: HTMLInputElement[]): string {
  const first = inputs[0]!;
  const fieldset = first.closest("fieldset");
  const legend = fieldset ? textOf(fieldset.querySelector("legend")) : "";
  if (legend) return legend;
  const group = first.closest("[role=radiogroup], [role=group]") as HTMLElement | null;
  if (group) {
    const t = byIds(group.getAttribute("aria-labelledby")) || clean(group.getAttribute("aria-label"));
    if (t) return t;
  }
  // nearest ancestor that contains all inputs, then its label-like child
  let node: HTMLElement | null = first.parentElement;
  while (node && !inputs.every((i) => node!.contains(i))) node = node.parentElement;
  for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
    const lbl = node.querySelector(":scope > label, :scope > legend, :scope > .application-label, :scope > [class*='label' i], :scope > p, :scope > div > label");
    if (lbl && !inputs.some((i) => lbl.contains(i))) {
      const t = labelText(lbl);
      if (t) return t;
    }
  }
  return humanize(first.name);
}

function optionLabel(input: HTMLInputElement): string {
  if (input.id) {
    const lbl = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
    if (lbl && labelText(lbl)) return labelText(lbl);
  }
  const wrap = input.closest("label");
  if (wrap && labelText(wrap)) return labelText(wrap);
  return clean(input.getAttribute("aria-label")) || clean(input.value);
}

const isRequired = (el: HTMLElement, label: string, rawLabelHasStar: boolean) =>
  (el as HTMLInputElement).required || el.getAttribute("aria-required") === "true" || rawLabelHasStar || /\brequired\b/i.test(label);

function rawLabelHasStar(el: HTMLElement): boolean {
  const lbl = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : el.closest("label");
  return !!lbl && (/\*/.test(lbl.textContent ?? "") || /required/i.test(lbl.className));
}

const SKIP_INPUT_TYPES = new Set(["hidden", "submit", "button", "reset", "image", "password", "search", "range", "color"]);

let counter = 0;
function assignId(els: Element[], existing?: string | null): string {
  const id = existing || `f${++counter}`;
  els.forEach((e) => e.setAttribute(ID_ATTR, id));
  return id;
}

// ---------- generic HTML forms (Greenhouse, Lever, Ashby, Workday, most career sites) ----------

function captureGeneric(root: ParentNode): FormField[] {
  const fields: FormField[] = [];
  const seenGroups = new Set<string>();
  const controls = root.querySelectorAll<HTMLElement>("input, textarea, select, [role=combobox]");

  for (const el of controls) {
    if (el.closest("[data-jc-ui]")) continue;
    if (el instanceof HTMLInputElement) {
      const type = el.type.toLowerCase();
      if (SKIP_INPUT_TYPES.has(type)) continue;
      if (type === "file") {
        if (el.disabled) continue;
        const label = questionFor(el) || "File upload";
        fields.push({ id: assignId([el], el.getAttribute(ID_ATTR)), label, kind: "file", required: isRequired(el, label, rawLabelHasStar(el)) });
        continue;
      }
      if (!isVisible(el) && !(type === "radio" || type === "checkbox")) continue;
      if (el.getAttribute("role") === "combobox") {
        fields.push(comboField(el));
        continue;
      }
      if (type === "radio" || type === "checkbox") {
        const key = `${type}:${el.name || el.id}`;
        if (seenGroups.has(key)) continue;
        seenGroups.add(key);
        const group = el.name
          ? [...root.querySelectorAll<HTMLInputElement>(`input[type=${type}][name="${CSS.escape(el.name)}"]`)]
          : [el];
        if (!group.some((g) => isVisible(g) || isVisible(g.closest("label") ?? g))) continue;
        if (type === "checkbox" && group.length === 1) {
          // single consent-style checkbox: the option is its own label
          const opt = optionLabel(el);
          const q = containerQuestion(el) || opt;
          fields.push({
            id: assignId(group, el.getAttribute(ID_ATTR)),
            label: q,
            kind: "checkbox",
            required: el.required,
            options: [opt],
            value: el.checked ? [opt] : [],
          });
          continue;
        }
        const options = group.map(optionLabel);
        const label = groupQuestion(group);
        fields.push({
          id: assignId(group, el.getAttribute(ID_ATTR)),
          label,
          kind: type === "radio" ? "radio" : "checkbox",
          required: group.some((g) => g.required) || /\*/.test(label),
          options,
          value: type === "radio" ? options[group.findIndex((g) => g.checked)] ?? "" : options.filter((_, i) => group[i]?.checked),
        });
        continue;
      }
      const label = questionFor(el);
      if (!label) continue;
      fields.push({
        id: assignId([el], el.getAttribute(ID_ATTR)),
        label,
        kind: "text",
        inputType: type,
        required: isRequired(el, label, rawLabelHasStar(el)),
        value: el.value,
        placeholder: el.placeholder || undefined,
        maxLength: el.maxLength > 0 ? el.maxLength : undefined,
      });
    } else if (el instanceof HTMLTextAreaElement) {
      if (!isVisible(el)) continue;
      const label = questionFor(el);
      fields.push({
        id: assignId([el], el.getAttribute(ID_ATTR)),
        label: label || "Additional information",
        kind: "textarea",
        required: isRequired(el, label, rawLabelHasStar(el)),
        value: el.value,
        maxLength: el.maxLength > 0 ? el.maxLength : undefined,
      });
    } else if (el instanceof HTMLSelectElement) {
      if (!isVisible(el)) continue;
      const label = questionFor(el);
      const options = [...el.options].filter((o) => o.value !== "" && !/^(select|choose|--)/i.test(o.text.trim())).map((o) => clean(o.text));
      fields.push({
        id: assignId([el], el.getAttribute(ID_ATTR)),
        label,
        kind: "select",
        required: isRequired(el, label, rawLabelHasStar(el)),
        options,
        value: el.selectedIndex > 0 ? clean(el.options[el.selectedIndex]?.text) : "",
      });
    } else if (el.getAttribute("role") === "combobox" && isVisible(el)) {
      fields.push(comboField(el));
    }
  }
  return fields;
}

// Yes/No style questions rendered as a row of buttons (e.g. Ashby).
const NOT_CHOICES = /attach|upload|enter manually|dropbox|google drive|remove|clear|cancel|submit/i;

function captureButtonGroups(root: ParentNode): FormField[] {
  const fields: FormField[] = [];
  const seen = new Set<Element>();
  for (const btn of root.querySelectorAll<HTMLButtonElement>("button:not([type]), button[type=button]")) {
    if (!btn.closest("form, [class*='form' i], [class*='application' i]")) continue;
    const parent = btn.parentElement;
    if (!parent || seen.has(parent)) continue;
    seen.add(parent);
    // the row may also hold a hidden input that mirrors the choice
    const all = [...parent.children] as HTMLElement[];
    const kids = all.filter((k) => k.tagName === "BUTTON");
    if (kids.length < 2 || kids.length > 5 || all.some((k) => k.tagName !== "BUTTON" && !(k instanceof HTMLInputElement && !isVisible(k)))) continue;
    const options = kids.map((k) => clean(k.textContent));
    if (options.some((t) => !t || t.length > 24 || NOT_CHOICES.test(t)) || !isVisible(parent)) continue;
    const lbl = containerLabel(parent);
    if (!lbl) continue;
    const selected = kids.findIndex((k) => k.getAttribute("aria-pressed") === "true" || /\b(active|selected|checked)\b/i.test(k.className));
    fields.push({
      id: assignId(kids, kids[0]!.getAttribute(ID_ATTR)),
      label: labelText(lbl),
      kind: "radio",
      required: /\*/.test(lbl.textContent ?? "") || /required/i.test(lbl.className),
      options,
      value: selected >= 0 ? options[selected] : "",
    });
  }
  return fields;
}

// Custom dropdowns (react-select etc.): options appear only when opened.
function comboField(el: HTMLElement): FormField {
  const label = questionFor(el);
  const current = clean(el.closest("[class*='control' i], [class*='container' i]")?.querySelector("[class*='single-value' i], [class*='singleValue' i]")?.textContent);
  return {
    id: assignId([el], el.getAttribute(ID_ATTR)),
    label,
    kind: "select",
    required: isRequired(el, label, rawLabelHasStar(el)),
    value: current,
  };
}

// ---------- Google Forms ----------

function captureGoogleForm(): FormField[] {
  const fields: FormField[] = [];
  for (const item of document.querySelectorAll<HTMLElement>("[role=listitem]")) {
    const heading = item.querySelector("[role=heading]");
    if (!heading) continue;
    const rawTitle = heading.textContent ?? "";
    const label = clean(rawTitle);
    const required = /\*/.test(rawTitle) || !!item.querySelector("[aria-label='Required question']");
    const existing = item.getAttribute(ID_ATTR);

    const radios = [...item.querySelectorAll<HTMLElement>("[role=radio]")];
    const checks = [...item.querySelectorAll<HTMLElement>("[role=checkbox]")];
    const listbox = item.querySelector<HTMLElement>("[role=listbox]");
    const textarea = item.querySelector<HTMLTextAreaElement>("textarea");
    const input = item.querySelector<HTMLInputElement>("input:not([type=hidden])");
    const optText = (o: HTMLElement) => clean(o.getAttribute("data-value") ?? o.getAttribute("aria-label") ?? o.textContent);

    if (radios.length) {
      const options = radios.map(optText);
      fields.push({ id: assignId([item], existing), label, kind: "radio", required, options, value: options[radios.findIndex((r) => r.getAttribute("aria-checked") === "true")] ?? "" });
    } else if (checks.length) {
      const options = checks.map((c) => clean(c.getAttribute("data-answer-value") ?? c.getAttribute("aria-label")));
      fields.push({ id: assignId([item], existing), label, kind: "checkbox", required, options, value: options.filter((_, i) => checks[i]?.getAttribute("aria-checked") === "true") });
    } else if (listbox) {
      const options = [...listbox.querySelectorAll<HTMLElement>("[role=option]")].map(optText).filter((o) => o && !/^choose$/i.test(o));
      fields.push({ id: assignId([item], existing), label, kind: "select", required, options });
    } else if (textarea) {
      fields.push({ id: assignId([item], existing), label, kind: "textarea", required, value: textarea.value });
    } else if (input) {
      fields.push({ id: assignId([item], existing), label, kind: "text", inputType: input.type, required, value: input.value });
    }
  }
  return fields;
}

// ---------- page metadata ----------

export function detectSite(host = location.hostname, path = location.pathname): string {
  if (host.endsWith("greenhouse.io")) return "greenhouse";
  if (host.endsWith("lever.co")) return "lever";
  if (host === "jobs.ashbyhq.com") return "ashby";
  if (host === "docs.google.com" && path.startsWith("/forms")) return "google-forms";
  if (/myworkday(jobs|site)\.com$/.test(host)) return "workday";
  if (host.endsWith(".oraclecloud.com") && path.includes("/CandidateExperience/")) return "oracle";
  if (host.endsWith("smartrecruiters.com")) return "smartrecruiters";
  if (host === "apply.workable.com") return "workable";
  if (host.endsWith(".recruitee.com")) return "recruitee";
  if (host.endsWith(".icims.com")) return "icims";
  if (host.endsWith(".taleo.net")) return "taleo";
  if (/successfactors\.(com|eu)$/.test(host)) return "successfactors";
  return "generic";
}

const titleCase = (s: string) => s.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

export function guessCompanyRole(site: string): { company?: string; role?: string } {
  const title = document.title.trim();
  const h1 = textOf(document.querySelector("h1"));
  const parts = location.pathname.split("/").filter(Boolean);
  let m: RegExpMatchArray | null;
  if ((m = title.match(/^Job Application for (.+?) at (.+)$/i))) return { role: m[1], company: m[2] };
  if (site === "lever" && (m = title.match(/^(.+?) - (.+)$/))) return { company: m[1], role: m[2] };
  if ((m = title.match(/^(.+?) @ (.+)$/))) return { role: m[1], company: m[2] };
  if ((m = title.match(/^(.+?) at (.+?)(?: [|\-–] .*)?$/i))) return { role: m[1], company: m[2] };
  const company =
    site === "greenhouse" || site === "lever" || site === "ashby"
      ? titleCase(parts[0] === "embed" ? new URLSearchParams(location.search).get("for") ?? "" : parts[0] ?? "")
      : site === "workday"
        ? titleCase(location.hostname.split(".")[0] ?? "")
        : undefined;
  return { company: company || undefined, role: h1 || undefined };
}

// ---------- entry ----------

export function captureForm(formId: string, session = "", step = 1): CapturedForm | null {
  const site = detectSite();
  const fields = site === "google-forms" ? captureGoogleForm() : [...captureGeneric(document), ...captureButtonGroups(document)];
  const useful = fields.filter((f) => f.label && !/captcha|honeypot/i.test(f.label));
  if (useful.length < 2) return null;
  return {
    formId,
    session,
    step,
    url: location.href,
    site,
    ...guessCompanyRole(site),
    pageTitle: document.title,
    fields: useful,
    capturedAt: Date.now(),
  };
}

// Signature to detect meaningful changes between captures (new fields, not typed values).
export const formSignature = (f: CapturedForm) => f.fields.map((x) => `${x.id}:${x.kind}:${x.label}:${(x.options ?? []).length}`).join("|");

// ---------- buttons ----------

const visibleEnabled = (el: HTMLElement) =>
  isVisible(el) && !(el as HTMLButtonElement).disabled && el.getAttribute("aria-disabled") !== "true";

const buttonText = (el: Element) =>
  clean((el as HTMLElement).innerText || (el as HTMLInputElement).value || el.getAttribute("aria-label") || "");

const CLICKABLE = "button, [role=button], input[type=submit], input[type=button], a";

// "Apply" on a job description page: where the application starts.
const APPLY_RE = /^(apply|apply now|apply for this (job|role|position)|apply to this job|i'?m interested|start application|easy apply)$/i;

export function findApplyTarget(): HTMLElement | null {
  const els = [...document.querySelectorAll<HTMLElement>(CLICKABLE)].filter((e) => !e.closest("[data-jc-ui]"));
  return els.find((e) => APPLY_RE.test(buttonText(e).replace(/[›»→▸]/g, "").trim()) && visibleEnabled(e)) ?? null;
}

// "Next" / "Continue" on a multi-step form. Never anything that submits.
const NEXT_RE = /^(next|continue|save (and|&) continue|save (and|&) next|next step|proceed|continue to next step|go to next step)\b/i;
const NEVER_RE = /submit|send|finish|complete|review and submit|apply/i;

export function findNextButton(): HTMLElement | null {
  const els = [...document.querySelectorAll<HTMLElement>(CLICKABLE)]
    .filter((e) => !e.closest("[data-jc-ui]"))
    .filter((e) => {
      const t = buttonText(e).replace(/[›»→▸]/g, "").trim();
      return NEXT_RE.test(t) && !NEVER_RE.test(t) && visibleEnabled(e);
    });
  return els.at(-1) ?? null; // the bottom-most one is the form's own navigation
}

export const describeButton = buttonText;

// Fields the page marks as invalid after trying to advance.
export function invalidFieldLabels(): string[] {
  const out = new Set<string>();
  for (const el of document.querySelectorAll<HTMLElement>("[aria-invalid='true']")) {
    if (!isVisible(el)) continue;
    out.add(questionFor(el) || "a field");
  }
  return [...out].slice(0, 8);
}

// schema.org JobPosting on the page (most career sites have it for Google Jobs).
export function jobPostingTitle(): string | null {
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const data = JSON.parse(s.textContent ?? "");
      const items = Array.isArray(data) ? data : data["@graph"] ?? [data];
      const job = items.find((x: { "@type"?: unknown }) => x?.["@type"] === "JobPosting");
      if (job) return String(job.title ?? "");
    } catch {
      // ignore
    }
  }
  return null;
}

export const formControlCount = () =>
  document.querySelectorAll("input:not([type=hidden]):not([type=submit]):not([type=button]), textarea, select, [role=combobox], [role=radiogroup]").length;
