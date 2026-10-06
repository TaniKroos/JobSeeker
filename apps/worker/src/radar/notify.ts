// Instant alerts for strong matches: one Telegram message per tick, paused during quiet hours
// (jobs found then go out in the first message after). Only the owner's bot/chat, from secrets.

import type { Budget } from "./adapters";
import type { RadarConfig } from "./config";

const HOUR = 3_600_000;
const QUEUE_WINDOW = 12 * HOUR; // alerts still worth sending after quiet hours
const MAX_JOBS = 12;

export function isQuiet(cfg: RadarConfig, at: number): boolean {
  if (cfg.quietStart === cfg.quietEnd) return false;
  const h = Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hourCycle: "h23", timeZone: cfg.timeZone }).format(at));
  return cfg.quietStart > cfg.quietEnd ? h >= cfg.quietStart || h < cfg.quietEnd : h >= cfg.quietStart && h < cfg.quietEnd;
}

export const ago = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

interface AlertRow {
  id: string;
  title: string;
  location: string;
  url: string | null;
  apply_url: string | null;
  score: number;
  first_seen_at: number;
  company: string;
}

export function alertText(jobs: AlertRow[], more: number, now: number): string {
  const lines = jobs.map(
    (j) => `<b>${esc(j.title)}</b> · ${esc(j.company)}\n${esc(j.location || "Location not given")} · score ${j.score} · first seen ${ago(now - j.first_seen_at)}\n<a href="${esc(j.apply_url || j.url || "")}">Apply</a>`,
  );
  const head = `🛰 ${jobs.length + more} new match${jobs.length + more === 1 ? "" : "es"}`;
  return [head, ...lines, ...(more ? [`…and ${more} more. Ask Claude for get_new_jobs.`] : [])].join("\n\n");
}

export async function sendAlerts(env: Env, cfg: RadarConfig, now: number, budget: Budget): Promise<number> {
  if (!cfg.telegramToken || !cfg.telegramChat || isQuiet(cfg, now)) return 0;
  const { results } = await env.DB.prepare(
    `SELECT j.id, j.title, j.location, j.url, j.apply_url, j.score, j.first_seen_at, c.name AS company
     FROM jobs j JOIN companies c ON c.id = j.company_id
     WHERE j.notified_at IS NULL AND j.score >= ? AND j.first_seen_at > ?
     ORDER BY j.score DESC, j.first_seen_at DESC LIMIT 100`,
  )
    .bind(cfg.alertMin, now - QUEUE_WINDOW)
    .all<AlertRow>();
  if (!results.length || !budget.take()) return 0;
  const shown = results.slice(0, MAX_JOBS);
  const res = await fetch(`https://api.telegram.org/bot${cfg.telegramToken}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: cfg.telegramChat, text: alertText(shown, results.length - shown.length, now), parse_mode: "HTML", disable_web_page_preview: true }),
  });
  if (!res.ok) throw new Error(`Telegram HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  // Everything counted in the message is done, including the "…and N more".
  await env.DB.prepare("UPDATE jobs SET notified_at = ? WHERE id IN (SELECT value FROM json_each(?))")
    .bind(now, JSON.stringify(results.map((r) => r.id)))
    .run();
  return results.length;
}
