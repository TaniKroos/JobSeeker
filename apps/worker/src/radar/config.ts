// Radar settings. Numbers come from wrangler.jsonc vars; the Telegram bot and the owner are secrets
// (`wrangler secret put TELEGRAM_BOT_TOKEN` / TELEGRAM_CHAT_ID / RADAR_OWNER_EMAIL, or .dev.vars locally).

export interface RadarConfig {
  batch: number; // companies per tick
  subrequests: number; // fetches per tick (Free plan: 50)
  parseBytes: number; // board bytes parsed per tick (~8 ms CPU per MB; Free plan allows ~10 ms)
  alertMin: number; // score that triggers an instant alert
  quietStart: number; // local hour alerts pause…
  quietEnd: number; // …and resume
  timeZone: string;
  telegramToken?: string;
  telegramChat?: string;
  owners: string[]; // emails allowed to change the watchlist
}

const num = (v: unknown, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) && String(v ?? "").trim() !== "" ? n : d;
};

export function radarConfig(env: Env): RadarConfig {
  const e = env as unknown as Record<string, string | undefined>;
  const [qs, qe] = (e.RADAR_QUIET_HOURS ?? "23-7").split("-").map((h) => Number(h));
  return {
    batch: num(e.RADAR_BATCH, 42),
    subrequests: num(e.RADAR_SUBREQUESTS, 48),
    parseBytes: num(e.RADAR_PARSE_BYTES, 800_000),
    alertMin: num(e.RADAR_ALERT_MIN_SCORE, 70),
    quietStart: Number.isFinite(qs) ? qs! : 23,
    quietEnd: Number.isFinite(qe) ? qe! : 7,
    timeZone: e.RADAR_TIME_ZONE || "Asia/Kolkata",
    telegramToken: e.TELEGRAM_BOT_TOKEN || undefined,
    telegramChat: e.TELEGRAM_CHAT_ID || undefined,
    owners: (e.RADAR_OWNER_EMAIL ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
  };
}
