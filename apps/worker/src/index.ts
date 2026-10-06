import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import app from "./app";
import { purgeExpired } from "./db";
import { createServer } from "./mcp";
import { purgeRadar, runRadar } from "./radar/poller";

export { UserRoom } from "./room";

// Must match the daily entry in wrangler.jsonc "triggers"; every other cron runs the radar.
const DAILY_CRON = "17 3 * * *";

const mcpHandler = createMcpHandler(createServer, { route: "/mcp" });

// Built on first request: the canonical resource URL comes from PUBLIC_URL, or this Worker's own origin.
const providers = new Map<string, OAuthProvider<Env>>();

function getProvider(env: Env, base: string): OAuthProvider<Env> {
  let provider = providers.get(base);
  if (provider) return provider;
  provider = new OAuthProvider<Env>({
    apiRoute: "/mcp",
    apiHandler: { fetch: mcpHandler as any },
    defaultHandler: app as any,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
    resourceMetadata: {
      resource: `${base}/mcp`,
      resource_name: env.APP_NAME,
    },
  });
  providers.set(base, provider);
  return provider;
}

export default {
  fetch(request, env, ctx) {
    const base = (env.PUBLIC_URL || new URL(request.url).origin).replace(/\/$/, "");
    return getProvider({ ...env, PUBLIC_URL: base }, base).fetch(request, { ...env, PUBLIC_URL: base }, ctx);
  },
  async scheduled(event, env) {
    // Daily: delete applications older than 90 days, expired extension sign-ins, radar jobs older than 30 days.
    if (event.cron === DAILY_CRON) {
      const removed = await purgeExpired(env.DB);
      const radar = await purgeRadar(env.DB);
      console.log(JSON.stringify({ evt: "purge", ...removed, radar_jobs: radar.jobs, radar_marks: radar.marks }));
      return;
    }
    // Every 30 minutes: poll the due part of the radar watchlist.
    const tick = await runRadar(env);
    console.log(JSON.stringify({ evt: "radar_tick", ...tick }));
  },
} satisfies ExportedHandler<Env>;
