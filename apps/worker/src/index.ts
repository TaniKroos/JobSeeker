import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import app from "./app";
import { createServer } from "./mcp";

export { UserRoom } from "./room";

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
} satisfies ExportedHandler<Env>;
