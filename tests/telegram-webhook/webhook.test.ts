import assert from "node:assert/strict";
import {
  handleTelegramWebhook,
  processTelegramUpdate,
} from "../../supabase/functions/telegram-webhook/index.ts";
import type { WebhookConfig } from "../../supabase/functions/telegram-webhook/index.ts";

Deno.test("legacy default keeps EdgeRuntime and HTTP backend", async () => {
  const previous = globalThis.EdgeRuntime;
  const tasks: Promise<unknown>[] = [];
  globalThis.EdgeRuntime = { waitUntil: (task) => { tasks.push(task); } };
  try {
    const { config, backendCalls } = makeTestContext();
    const response = await handleTelegramWebhook(new Request("http://localhost/", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": "test-webhook-secret" },
      body: JSON.stringify(makeUpdate()),
    }), config);
    assert.equal(response.status, 200);
    assert.equal(tasks.length, 1);
    await Promise.all(tasks);
    assert.equal(backendCalls.length, 1);
  } finally { globalThis.EdgeRuntime = previous; }
});

Deno.test("legacy SUPABASE_URL fallback uses HTTP backend through waitUntil", async () => {
  const previousUrl = Deno.env.get("SUPABASE_URL");
  const previousRuntime = globalThis.EdgeRuntime;
  const tasks: Promise<unknown>[] = [];
  const backend = Promise.withResolvers<Response>();
  const calls: Array<{ url: string; method?: string; headers: Headers; body: unknown }> = [];
  globalThis.EdgeRuntime = { waitUntil: (task) => { tasks.push(task); } };
  try {
    Deno.env.set("SUPABASE_URL", "https://legacy-test.invalid");
    const config: WebhookConfig = {
      telegramBotToken: "test-bot-token",
      webhookSecret: "test-webhook-secret",
      allowedUserIds: "123",
      internalApiToken: "test-internal-token",
      // Deliberately no backendHandler, backendUrl or executionMode override.
      fetchFn: (input, init) => {
        calls.push({
          url: input instanceof Request ? input.url : String(input),
          method: init?.method,
          headers: new Headers(init?.headers),
          body: JSON.parse(String(init?.body)),
        });
        return calls.length === 1 ? backend.promise : Promise.resolve(Response.json({ ok: true }));
      },
    };
    const response = await handleTelegramWebhook(new Request("http://localhost/", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": "test-webhook-secret" },
      body: JSON.stringify(makeUpdate({ text: "Тур" })),
    }), config);
    // ACK arrives while the HTTP backend is still pending.
    assert.equal(response.status, 200);
    assert.equal(tasks.length, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://legacy-test.invalid/functions/v1/travel-offer-text");
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].headers.get("X-Internal-Token"), "test-internal-token");
    assert.equal(calls[0].headers.get("Content-Type"), "application/json");
    assert.deepEqual(calls[0].body, { text: "Тур" });
    backend.resolve(Response.json({ status: "ready", offer: { client_message: "Legacy ready" } }));
    await Promise.all(tasks);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].url, "https://api.telegram.org/bottest-bot-token/sendMessage");
    assert.deepEqual(calls[1].body, { chat_id: 123, text: "Legacy ready" });
  } finally {
    backend.resolve(Response.json({ status: "ready" }));
    await Promise.allSettled(tasks);
    globalThis.EdgeRuntime = previousRuntime;
    if (previousUrl === undefined) Deno.env.delete("SUPABASE_URL");
    else Deno.env.set("SUPABASE_URL", previousUrl);
  }
});

type TelegramBody = {
  chat_id: number;
  text: string;
  reply_markup?: { force_reply: boolean; selective: boolean };
};

type BackendBody = {
  text: string;
};

type RecordedTelegramCall = { url: string; body: TelegramBody };
type RecordedBackendCall = { url: string; body: BackendBody };

function makeTestContext(backendResponse?: Record<string, unknown>, backendStatus = 200) {
  const telegramCalls: RecordedTelegramCall[] = [];
  const backendCalls: RecordedBackendCall[] = [];

  const fetchFn: typeof fetch = (url: string | URL | Request, opts?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    const body = opts?.body ? JSON.parse(opts.body as string) : {};
    if (urlStr.includes("api.telegram.org")) {
      telegramCalls.push({ url: urlStr, body: body as TelegramBody });
      return Promise.resolve(new Response("{}", { status: 200 }));
    }
    if (urlStr.includes("travel-offer-text")) {
      backendCalls.push({ url: urlStr, body: body as BackendBody });
      return Promise.resolve(
        new Response(JSON.stringify(backendResponse ?? { status: "ready" }), {
          status: backendStatus,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  };

  const config: WebhookConfig = {
    telegramBotToken: "test-bot-token",
    webhookSecret: "test-webhook-secret",
    allowedUserIds: "123",
    internalApiToken: "test-internal-token",
    backendUrl: "http://localhost/travel-offer-text",
    fetchFn,
  };

  return { telegramCalls, backendCalls, config };
}

function makeUpdate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      from: { id: 123, is_bot: false, first_name: "Test" },
      chat: { id: 123, type: "private" },
      text: "Hello",
      date: 0,
      ...overrides,
    },
  };
}

Deno.test("1. invalid webhook secret returns 401", async () => {
  const { config } = makeTestContext();
  const req = new Request("http://localhost/", {
    method: "POST",
    headers: { "X-Telegram-Bot-Api-Secret-Token": "wrong-secret" },
    body: JSON.stringify({ update_id: 1 }),
  });
  const res = await handleTelegramWebhook(req, config);
  assert.strictEqual(res.status, 401);
  const json = await res.json();
  assert.strictEqual(json.error, "Unauthorized");
});

Deno.test("2. user outside allowlist does not call backend", async () => {
  const { telegramCalls, backendCalls, config } = makeTestContext();
  const update = makeUpdate({
    from: { id: 999, is_bot: false, first_name: "Stranger" },
    chat: { id: 999, type: "private" },
    text: "Хочу в Турцию",
  });
  await processTelegramUpdate(update, config);
  assert.strictEqual(backendCalls.length, 0);
  assert.strictEqual(telegramCalls.length, 0);
});

Deno.test("3. /start does not call backend", async () => {
  const { telegramCalls, backendCalls, config } = makeTestContext();
  const update = makeUpdate({ text: "/start" });
  await processTelegramUpdate(update, config);
  assert.strictEqual(backendCalls.length, 0);
  assert.strictEqual(telegramCalls.length, 1);
  assert.ok(telegramCalls[0].body.text.includes("Добро пожаловать"));
  assert.strictEqual(telegramCalls[0].body.chat_id, 123);
});

Deno.test("4. regular text is passed to /travel-offer-text", async () => {
  const { telegramCalls, backendCalls, config } = makeTestContext();
  const update = makeUpdate({ text: "Хочу в Турцию на двоих" });
  await processTelegramUpdate(update, config);
  assert.strictEqual(backendCalls.length, 1);
  assert.strictEqual(backendCalls[0].body.text, "Хочу в Турцию на двоих");
  assert.ok(backendCalls[0].url.includes("travel-offer-text"));
  assert.strictEqual(telegramCalls.length, 0);
});

Deno.test("5. ready status sends agent_summary and client_message", async () => {
  const { telegramCalls, backendCalls, config } = makeTestContext({
    status: "ready",
    parsed_request: { departure: "Москва" },
    resolved_request: { departure: { id: 1, name: "Москва" } },
    offer: {
      ranked_tours: [],
      agent_summary: "Агент: подобрано 3 варианта.",
      client_message: "Клиент: вот лучшие туры в Турцию.",
      warnings: [],
    },
  });
  const update = makeUpdate({ text: "Хочу в Турцию" });
  await processTelegramUpdate(update, config);
  assert.strictEqual(backendCalls.length, 1);
  assert.strictEqual(telegramCalls.length, 2);
  assert.strictEqual(telegramCalls[0].body.text, "Агент: подобрано 3 варианта.");
  assert.strictEqual(telegramCalls[1].body.text, "Клиент: вот лучшие туры в Турцию.");
  assert.ok(!telegramCalls[0].body.reply_markup);
  assert.ok(!telegramCalls[1].body.reply_markup);
});

Deno.test("6. needs_clarification sends ForceReply with original query", async () => {
  const { telegramCalls, backendCalls, config } = makeTestContext({
    status: "needs_clarification",
    question: "Уточните город вылета.",
    parsed_request: { departure: null },
  });
  const update = makeUpdate({ text: "Хочу в Турцию" });
  await processTelegramUpdate(update, config);
  assert.strictEqual(backendCalls.length, 1);
  assert.strictEqual(telegramCalls.length, 1);
  const msg = telegramCalls[0];
  assert.ok(msg.body.text.includes("Уточните город вылета."));
  assert.ok(msg.body.text.includes("Исходный запрос: Хочу в Турцию"));
  assert.ok(msg.body.reply_markup);
  assert.strictEqual(msg.body.reply_markup.force_reply, true);
  assert.strictEqual(msg.body.reply_markup.selective, true);
  assert.strictEqual(msg.body.chat_id, 123);
});

Deno.test("7. reply to clarification combines original text with user answer", async () => {
  const { telegramCalls, backendCalls, config } = makeTestContext({
    status: "ready",
    parsed_request: { departure: "Москва" },
    resolved_request: { departure: { id: 1, name: "Москва" } },
    offer: {
      ranked_tours: [],
      agent_summary: "Готово.",
      client_message: "Туры найдены.",
      warnings: [],
    },
  });
  const update = makeUpdate({
    text: "Москва",
    reply_to_message: {
      message_id: 1,
      text: "Уточните город вылета.\n\nИсходный запрос: Хочу в Турцию",
      from: { id: 123, is_bot: true },
      chat: { id: 123, type: "private" },
      date: 0,
    },
  });
  await processTelegramUpdate(update, config);
  assert.strictEqual(backendCalls.length, 1);
  assert.strictEqual(backendCalls[0].body.text, "Хочу в Турцию Москва");
  assert.strictEqual(telegramCalls.length, 2);
});
