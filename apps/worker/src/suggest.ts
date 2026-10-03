// Server-side pre-matching of form fields to facts the AI assistant passes in (from its own memory of
// the user), so Claude only writes answers for the questions that are actually new. The facts are used
// for the one request and never stored.

import type { FormField } from "@job-copilot/shared";

export interface Suggestion {
  value: string | string[];
  from: string; // e.g. "facts.email", "EEO: decline"
}

type Profile = Record<string, unknown>;

const str = (v: unknown): string | undefined => {
  if (v == null) return undefined;
  if (Array.isArray(v)) return v.join(", ");
  const s = String(v).trim();
  return s || undefined;
};

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[*.:?]+$/, "")
    .trim();

const boundaryPrefix = (long: string, short: string) =>
  !!short && long.startsWith(short) && (long.length === short.length || /[^a-z0-9]/.test(long[short.length]!));

// Same matching rules as the extension: exact, then word-boundary prefix either way.
export function matchOption(options: string[], wanted: string): string | undefined {
  const w = norm(wanted);
  if (!w) return undefined;
  return (
    options.find((o) => norm(o) === w) ??
    options.find((o) => boundaryPrefix(norm(o), w)) ??
    options.find((o) => boundaryPrefix(w, norm(o)))
  );
}

const yesNo = (v: unknown): "yes" | "no" | undefined => {
  if (typeof v === "boolean") return v ? "yes" : "no";
  const s = str(v)?.toLowerCase();
  if (!s) return undefined;
  if (/^(yes|y|true|authorized|authorised|citizen|i do|i am|willing)\b/.test(s)) return "yes";
  if (/^(no|n|false|not|none|i do not|i don't)\b/.test(s)) return "no";
  return undefined;
};

const splitName = (p: Profile) => {
  const full = str(p.full_name) ?? str(p.name);
  const parts = full?.split(/\s+/) ?? [];
  return {
    first: str(p.first_name) ?? parts[0],
    last: str(p.last_name) ?? (parts.length > 1 ? parts.slice(1).join(" ") : undefined),
    full,
  };
};

interface Rule {
  test: RegExp;
  kinds?: FormField["kind"][];
  value: (p: Profile) => string | undefined;
  from: string;
  boolean?: boolean; // map to a Yes/No style option
  word?: boolean; // pick the option containing the value as a word (e.g. "remote")
}

const RULES: Rule[] = [
  { test: /\bpreferred (first )?name\b|what (would you like|should we) (us to )?call you/, value: (p) => str(p.preferred_name) ?? splitName(p).first, from: "facts.preferred_name" },
  { test: /\bfirst name\b|\bgiven name\b/, value: (p) => splitName(p).first, from: "facts.full_name" },
  { test: /\blast name\b|\bsurname\b|\bfamily name\b/, value: (p) => splitName(p).last, from: "facts.full_name" },
  { test: /^(full |legal |your )?name$|\bfull name\b|\blegal name\b/, value: (p) => splitName(p).full, from: "facts.full_name" },
  { test: /\be-?mail\b/, kinds: ["text"], value: (p) => str(p.email), from: "facts.email" },
  { test: /\bphone\b|\bmobile\b|\bcontact number\b/, kinds: ["text"], value: (p) => str(p.phone), from: "facts.phone" },
  { test: /linkedin/, kinds: ["text"], value: (p) => str(p.linkedin), from: "facts.linkedin" },
  { test: /github/, kinds: ["text"], value: (p) => str(p.github), from: "facts.github" },
  { test: /portfolio|personal (web)?site|^website\b/, kinds: ["text"], value: (p) => str(p.portfolio) ?? str(p.website), from: "facts.portfolio" },
  { test: /\b(current|previous|most recent)\b.*\b(company|employer)\b|^(current )?(company|employer)$/, kinds: ["text", "textarea"], value: (p) => str(p.current_company), from: "facts.current_company" },
  { test: /\b(current|previous|most recent)\b.*\b(job )?title\b|\bdesignation\b|^(job )?title$/, kinds: ["text"], value: (p) => str(p.current_title), from: "facts.current_title" },
  { test: /years of (relevant |professional |total )?experience|experience \(years\)|total experience/, value: (p) => str(p.years_experience), from: "facts.years_experience" },
  { test: /notice period/, value: (p) => str(p.notice_period), from: "facts.notice_period" },
  { test: /current (ctc|salary|compensation|pay)/, value: (p) => str(p.current_ctc), from: "facts.current_ctc" },
  { test: /expected (ctc|salary|compensation)|salary expectation|desired (salary|compensation)/, value: (p) => str(p.expected_ctc), from: "facts.expected_ctc" },
  { test: /\b(school|university|college|institution)\b/, value: (p) => str(p.college), from: "facts.college" },
  { test: /\bdegree\b|highest (level of )?(education|qualification)/, value: (p) => str(p.degree), from: "facts.degree" },
  { test: /graduat(ion|e|ed)\b.*\b(year|date)|year of (graduation|passing)/, value: (p) => str(p.graduation_year), from: "facts.graduation_year" },
  { test: /\b(c?gpa|grade point|percentage)\b/, value: (p) => str(p.cgpa), from: "facts.cgpa" },
  { test: /\b(sponsor|sponsorship)\b/, value: (p) => str(p.requires_sponsorship), from: "facts.requires_sponsorship", boolean: true },
  { test: /authori[sz]ed to work|legally (authori[sz]ed|eligible|entitled)|right to work|eligible to work/, value: (p) => str(p.work_authorization), from: "facts.work_authorization", boolean: true },
  { test: /relocat/, value: (p) => str(p.willing_to_relocate), from: "facts.willing_to_relocate", boolean: true },
  { test: /\bremote\b.*\b(intend|prefer|would you)|work (from|location) preference|(remote|hybrid|on-?site|office) preference/, value: (p) => str(p.work_preference), from: "facts.work_preference", word: true },
  { test: /\bcountry\b.*\b(reside|residence|live|located|based)\b|\bcountry of residence\b|^country$/, value: (p) => str(p.country), from: "facts.country" },
  { test: /\b(current )?(city|location)\b(?!.*\bwilling\b)/, kinds: ["text", "select"], value: (p) => str(p.city), from: "facts.city" },
  { test: /\bpronouns?\b/, kinds: ["text"], value: (p) => str(p.pronouns), from: "facts.pronouns" },
];

const EEO = /\b(gender|sex|race|racial|ethnicity|hispanic|latino|veteran|disability|disabled|sexual orientation|transgender|lgbt)/;
const DECLINE = /decline|prefer not|don.t wish|do not wish|not to (say|answer|disclose|self.identify)|choose not|rather not/;

function toOption(field: FormField, value: string, rule?: Rule): string | undefined {
  const options = field.options ?? [];
  if (!options.length) return field.kind === "select" ? value : undefined; // custom dropdown with unknown options: let the extension match
  if (rule?.boolean) {
    const yn = yesNo(value);
    if (!yn) return undefined;
    return options.find((o) => new RegExp(`^${yn}\\b`, "i").test(o.trim()));
  }
  if (rule?.word) {
    const w = value.toLowerCase().replace(/[^a-z]/g, "");
    const key = /remote/.test(w) ? "remote" : /hybrid/.test(w) ? "hybrid" : /office|onsite/.test(w) ? "office|on-?site" : w;
    return options.find((o) => new RegExp(`\\b(${key})\\b`, "i").test(o));
  }
  return matchOption(options, value);
}

export function suggestFor(field: FormField, profile: Profile): Suggestion | undefined {
  if (field.kind === "file" || field.hasValue) return undefined;
  const label = norm(field.label);

  // Voluntary EEO questions: decline by default.
  if (EEO.test(label) && field.kind !== "text" && field.kind !== "textarea") {
    if (field.options?.length) {
      const decline = field.options.find((o) => DECLINE.test(o.toLowerCase()));
      if (decline) return { value: field.kind === "checkbox" ? [decline] : decline, from: "EEO: decline to answer" };
    } else if (field.kind === "select") {
      // options only appear when the dropdown opens: the extension picks the "decline" one
      return { value: "(decline to answer)", from: "EEO: decline to answer" };
    }
  }

  for (const rule of RULES) {
    if (rule.kinds && !rule.kinds.includes(field.kind)) continue;
    if (!rule.test.test(label)) continue;
    const v = rule.value(profile);
    if (!v) return undefined; // the right rule matched but the profile lacks the fact
    if (field.kind === "text" || field.kind === "textarea") return { value: v, from: rule.from };
    const opt = toOption(field, v, rule);
    if (!opt) return undefined;
    return { value: field.kind === "checkbox" ? [opt] : opt, from: rule.from };
  }
  return undefined;
}
