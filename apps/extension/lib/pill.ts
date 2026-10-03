// The small status pill shown on job pages, isolated in a Shadow DOM so site CSS can't touch it.

export type PillTone = "ready" | "working" | "done" | "warn";

export interface PillAction {
  label: string;
  onClick: () => void;
}

const CSS = `
:host{all:initial}
.pill{position:fixed;right:16px;bottom:16px;z-index:2147483647;display:flex;align-items:center;gap:10px;max-width:min(420px,calc(100vw - 32px));
  padding:8px 8px 8px 12px;border-radius:999px;background:#1d1d1f;color:#f5f5f7;font:500 13px/1.3 system-ui,-apple-system,"Segoe UI",sans-serif;
  box-shadow:0 6px 24px rgba(0,0,0,.25);transition:opacity .2s,transform .2s}
.dot{width:8px;height:8px;border-radius:50%;flex:none;background:#8e8e93}
.ready .dot{background:#30d158}.working .dot{background:#ffd60a;animation:p 1s infinite}.done .dot{background:#0a84ff}.warn .dot{background:#ff9f0a}
@keyframes p{50%{opacity:.35}}
.text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bar{position:absolute;left:14px;right:14px;bottom:3px;height:2px;border-radius:2px;background:rgba(255,255,255,.12);overflow:hidden;display:none}
.bar i{display:block;height:100%;width:0;background:#ffd60a;transition:width .2s}
.working .bar{display:block}
.act{all:unset;cursor:pointer;flex:none;padding:5px 10px;border-radius:999px;background:#f5f5f7;color:#1d1d1f;font:600 12px/1.2 system-ui,-apple-system,"Segoe UI",sans-serif}
.act:hover{background:#fff}.act:focus-visible{outline:2px solid #0a84ff;outline-offset:2px}
.x{all:unset;cursor:pointer;color:#8e8e93;padding:0 4px;font-size:16px;line-height:1}
.x:hover{color:#f5f5f7}
.hidden{opacity:0;pointer-events:none;transform:translateY(8px)}
`;

export class Pill {
  private box: HTMLDivElement;
  private label: HTMLSpanElement;
  private act: HTMLButtonElement;
  private bar: HTMLElement;
  private onAct: (() => void) | null = null;
  private dismissed = false;

  constructor() {
    const host = document.createElement("div");
    host.setAttribute("data-jc-ui", "");
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `<style>${CSS}</style><div class="pill hidden" role="status" aria-live="polite"><span class="dot"></span><span class="text"></span><button class="act" hidden></button><button class="x" title="Hide" aria-label="Hide">×</button><span class="bar"><i></i></span></div>`;
    this.box = root.querySelector(".pill")!;
    this.label = root.querySelector(".text")!;
    this.act = root.querySelector(".act")!;
    this.bar = root.querySelector(".bar i")!;
    this.act.addEventListener("click", () => this.onAct?.());
    root.querySelector(".x")!.addEventListener("click", () => {
      this.dismissed = true;
      this.box.classList.add("hidden");
    });
    document.documentElement.appendChild(host);
  }

  show(text: string, tone: PillTone, opts: { action?: PillAction; force?: boolean; progress?: number } = {}) {
    if (this.dismissed && !opts.force) return;
    if (opts.force) this.dismissed = false;
    this.label.textContent = text;
    this.label.title = text;
    this.box.className = `pill ${tone}`;
    this.onAct = opts.action?.onClick ?? null;
    this.act.hidden = !opts.action;
    if (opts.action) this.act.textContent = opts.action.label;
    this.bar.style.width = `${Math.round((opts.progress ?? 0) * 100)}%`;
  }
}
