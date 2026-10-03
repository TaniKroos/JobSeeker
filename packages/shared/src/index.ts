// Types shared by the Worker and the Chrome extension.

export type FieldKind =
  | "text" // single-line input (text, email, tel, url, number, date)
  | "textarea"
  | "select" // single choice from options (native <select> or custom listbox)
  | "radio" // single choice from options rendered as radio buttons
  | "checkbox" // one or more choices from options
  | "file"; // resume / cover letter upload; always left for the user

export interface FormField {
  id: string; // stable within one captured form, e.g. "f3"
  label: string;
  kind: FieldKind;
  inputType?: string; // original input type for "text" fields (email, tel, url…)
  required: boolean;
  options?: string[]; // for select / radio / checkbox
  value?: string | string[]; // current value on the page, if any
  placeholder?: string;
  maxLength?: number;
}

export interface CapturedForm {
  formId: string;
  session: string; // stable for one application in one tab, across pages/steps
  step: number; // increases every time the form's questions change (next page of a multi-step form)
  url: string;
  site: string; // greenhouse | lever | ashby | google-forms | workday | generic
  company?: string;
  role?: string;
  pageTitle: string;
  fields: FormField[];
  capturedAt: number;
}

export interface FillAnswer {
  fieldId: string;
  value: string | string[];
}

export type FillStatus = "filled" | "skipped" | "failed" | "needs_user";

// A job page without an application form (e.g. the description page with an "Apply" button).
export interface PageInfo {
  session: string;
  url: string;
  title: string;
  site: string;
  company?: string;
  role?: string;
  applyLink?: string; // where the Apply button goes, when it's a link
  hasApplyButton: boolean;
  seenAt: number;
}

export interface AdvanceResult {
  clicked: boolean;
  button?: string; // text of the button that was clicked
  note?: string; // why it did not advance
}

export interface FillResult {
  fieldId: string;
  label: string;
  status: FillStatus;
  note?: string;
}

// Messages from the extension to the server (over the WebSocket).
export type ExtToServer =
  | { type: "form"; form: CapturedForm }
  | { type: "form_closed"; formId: string }
  | { type: "page"; page: PageInfo }
  | { type: "page_closed"; session: string }
  | { type: "advance_blocked"; formId: string; note: string }
  | { type: "fill_result"; requestId: string; formId: string; results: FillResult[]; advance?: AdvanceResult }
  | {
      type: "submitted";
      formId: string;
      url: string;
      company?: string;
      role?: string;
      // long free-text answers the user submitted, to grow the answer bank
      answers?: { question: string; answer: string }[];
    };

// Messages from the server to the extension.
export type ServerToExt =
  | { type: "fill"; requestId: string; formId: string; answers: FillAnswer[]; advance?: boolean }
  | { type: "hello"; email: string };

export const PING = "ping";
export const PONG = "pong";
