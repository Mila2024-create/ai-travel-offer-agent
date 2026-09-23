import {
  handleTelegramWebhook,
  type WebhookConfig,
} from "../supabase/functions/telegram-webhook/index.ts";
import { handleTravelOfferTextRequest } from "../supabase/functions/travel-offer-text/index.ts";

export function createContainerHandler(config: WebhookConfig = {}) {
  const webhookConfig: WebhookConfig = {
    ...config,
    executionMode: "request",
    backendHandler: config.backendHandler ?? ((request) =>
      handleTravelOfferTextRequest(request, {
        internalApiToken: config.internalApiToken,
        fetchFn: config.fetchFn,
      })),
  };
  return async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    const method = path === "/health" ? "GET" : path === "/telegram-webhook" ? "POST" : null;
    if (!method) return new Response("Not found", { status: 404 });
    if (request.method !== method) {
      return new Response(null, { status: 405, headers: { Allow: method } });
    }
    if (path === "/health") return Response.json({ ok: true });
    try {
      return await handleTelegramWebhook(request, webhookConfig);
    } catch {
      console.error(JSON.stringify({ stage: "webhook", error: "PROCESSING_FAILED" }));
      return Response.json({ error: "Internal server error" }, { status: 500 });
    }
  };
}

export function containerPort(value = Deno.env.get("PORT")): number {
  if (value === undefined) return 8080;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
    throw new Error("Invalid PORT configuration");
  }
  return Number(value);
}

if (import.meta.main) {
  Deno.serve({ hostname: "0.0.0.0", port: containerPort() }, createContainerHandler());
}
