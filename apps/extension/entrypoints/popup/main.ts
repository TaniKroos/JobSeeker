import { browser } from "wxt/browser";
import type { PopupMsg, PopupState } from "../background";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const send = <T>(msg: PopupMsg) => browser.runtime.sendMessage(msg) as Promise<T>;

function showError(e: unknown) {
  const el = $("error");
  el.textContent = e instanceof Error ? e.message : String(e);
  el.hidden = false;
}

async function render() {
  const s = await send<PopupState>({ type: "popup:state" });
  $("signedOut").hidden = !!s.email;
  $("signedIn").hidden = !s.email;
  $("disconnect").hidden = !s.email;
  $("email").textContent = s.email ?? "";
  const dot = $("dot");
  dot.classList.toggle("on", s.connected);
  dot.title = s.connected ? "Live connection open" : "Connects when an application page is open";
  $<HTMLInputElement>("server").value = s.server;
  $<HTMLInputElement>("allSites").checked = s.allSites;
  $("mcpUrl").textContent = `${s.server}/mcp`;
  const forms = $("forms");
  forms.replaceChildren(
    ...s.forms.map((f) => {
      const div = document.createElement("div");
      div.className = "form";
      const b = document.createElement("b");
      b.textContent = [f.role, f.company].filter(Boolean).join(" · ") || "Application form";
      div.append(b, document.createTextNode(`${f.step > 1 ? `Page ${f.step} · ` : ""}${f.fields} fields captured. Ask Claude to “fill it”.`));
      return div;
    }),
  );
  if (!s.forms.length && s.email) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = "No application form open.";
    forms.append(p);
  }
}

async function run(msg: PopupMsg) {
  $("error").hidden = true;
  const r = await send<{ error?: string }>(msg);
  if (r?.error) showError(r.error);
  await render();
}

$("connect").addEventListener("click", () => run({ type: "popup:connect" }));
$("disconnect").addEventListener("click", () => run({ type: "popup:disconnect" }));
$("saveServer").addEventListener("click", () => run({ type: "popup:server", server: $<HTMLInputElement>("server").value.trim() }));
$("inject").addEventListener("click", async () => {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab?.id != null) await run({ type: "popup:inject", tabId: tab.id });
});

$<HTMLInputElement>("allSites").addEventListener("change", async (e) => {
  const enabled = (e.target as HTMLInputElement).checked;
  // The permission prompt must come from this click, so request it here (not in the background).
  if (enabled && !(await browser.permissions.request({ origins: ["<all_urls>"] }))) {
    (e.target as HTMLInputElement).checked = false;
    return;
  }
  await run({ type: "popup:allsites", enabled });
});

render().catch(showError);
