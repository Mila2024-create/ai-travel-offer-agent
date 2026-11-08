# AI Travel Offer Bot

Telegram MVP using TypeScript, Deno 2, OpenRouter, Tourvisor and local ranking.

## Container mode

`container/main.ts` runs one server on `0.0.0.0:$PORT` (local default 8080).
`POST /telegram-webhook` validates the secret and allowlist, calls the existing
travel-offer-text handler directly, waits for processing and Telegram send attempts,
then responds. It never uses EdgeRuntime.waitUntil. `GET /health` returns static
success without upstream calls. Unknown routes return 404; unsupported methods
return 405. Webhook bodies are limited to 64 KiB, also without Content-Length.

Required variables: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET,
TELEGRAM_ALLOWED_USER_IDS (comma-separated), OPENROUTER_API_KEY, OPENROUTER_MODEL,
TOURVISOR_JWT, INTERNAL_API_TOKEN. See `.env.example` for empty placeholders.
Cloud.ru supplies PORT. SUPABASE_URL is not needed in container mode.
Never put real credentials in the image or repository.

With variables supplied externally:

```sh
deno run --frozen --allow-net --allow-env=KT02_DIAGNOSTICS,PORT,TELEGRAM_BOT_TOKEN,TELEGRAM_WEBHOOK_SECRET,TELEGRAM_ALLOWED_USER_IDS,OPENROUTER_API_KEY,OPENROUTER_MODEL,TOURVISOR_JWT,INTERNAL_API_TOKEN container/main.ts
docker build --platform linux/amd64 -t ai-travel-offer-bot:local .
docker run --rm -p 8080:8080 --env-file /path/to/private.env ai-travel-offer-bot:local
```

The image pins Deno 2, uses UID 1000 and caches dependencies during build.
Startup uses cached dependencies only. Stage 2 and migrations are excluded.
No database, worker, queue or Potok delivery is introduced.

## Safe checks

```sh
deno check --frozen container/main.ts tests/container/main.test.ts tests/telegram-webhook/webhook.test.ts
deno lint container/main.ts tests/container/main.test.ts supabase/functions/telegram-webhook/index.ts tests/telegram-webhook/webhook.test.ts
deno fmt --check container/main.ts tests/container/main.test.ts supabase/functions/telegram-webhook/index.ts tests/telegram-webhook/webhook.test.ts README.md
deno test --frozen --allow-read --allow-env=OPENROUTER_API_KEY,OPENROUTER_MODEL tests/unit tests/parser tests/tourvisor tests/spike tests/telegram-webhook tests/container
```

Tests have no network permission and use mocked upstream responses. The commands
exclude Stage 2 integration tests. Do not apply its migration for this work.

## KT-02 local diagnostics

Container diagnostics are off by default. Only the separate KT-02 test service may
explicitly set `KT02_DIAGNOSTICS=true`; other values leave legacy behavior intact.
Local mocked handlers can opt in with `diagnosticsEnabled: true`.
No environment or deployment configuration is changed by this patch.

Each webhook delivery gets its own random `request_id`, validated numeric
`update_id`, phase events, elapsed milliseconds and sequential send counters.
`response_ready` records the HTTP status prepared by the application, not receipt
of that response by Telegram. `http_ok` means HTTP success, not verified delivery.
Send duration covers the fetch until response headers or an exception; response
bodies are not read for diagnostics. Backend start/end events and existing backend
milestones share the request context; these do not time every upstream operation.

In diagnostic requests, existing application logs also pass through a closed
field/value allowlist. Message text, identity fields, URLs, query parameters,
headers, upstream bodies and raw exception names/messages/stacks/causes are never
emitted. Recognized exception names and codes are mapped to fixed values;
unrecognized values become `unknown`. Context is isolated with AsyncLocalStorage;
there is no global console interception. Logs outside diagnostic requests retain
their previous payloads and must not be treated as newly sanitized.

No timeout, retry, deduplication or HTTP acknowledgement policy is introduced.
Failed sends still permit HTTP 200 and later parts still run after a part fails.
Repeated updates remain repeated processing. A stalled send remains stalled.

Offline checks after dependencies are cached (no network permission):

```sh
deno test --cached-only --frozen --allow-read --allow-env=OPENROUTER_API_KEY,OPENROUTER_MODEL,TOURVISOR_JWT,SUPABASE_URL tests/container tests/telegram-webhook
```

Review and a separate owner decision are required before any test deployment.
Do not enable this setting on the working service or reuse its bot credentials.

## Existing Supabase deployment

Default webhook configuration retains the SUPABASE_URL HTTP backend and
EdgeRuntime.waitUntil when available. The container explicitly overrides both.
Parser, validation, Tourvisor, ranking, offer formatting and Potok mapper are unchanged.

## Remaining deployment checks and risks

These files perform no deployment or Telegram webhook registration. Validate the
image, API connectivity, request timeout and memory/CPU usage before deployment.
0.1 vCPU / 256 MB is an initial test configuration, not measured capacity.

Processing can exceed 60 seconds. Cloud.ru's request timeout does not control
Telegram's delivery timeout. Retries can repeat searches and messages; persistent
deduplication is not connected. Restarts can interrupt processing. Telegram send
errors are logged safely and count as an attempt, not guaranteed delivery.
Unexpected processing errors return a generic 500; handled backend failures send
a generic Telegram error before HTTP 200.

Stage 2 request_id/revision state remains disconnected and untouched. Future
persistent idempotency must preserve that contract. This container does not claim
exactly-once processing. Test repeat delivery before production use.
