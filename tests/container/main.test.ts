import assert from "node:assert/strict";
import { containerPort, createContainerHandler } from "../../container/main.ts";
import type { WebhookConfig } from "../../supabase/functions/telegram-webhook/index.ts";

function request(text = "Тур", secret = "secret", user = 123) {
  return new Request("http://localhost/telegram-webhook", {
    method: "POST",
    headers: { "X-Telegram-Bot-Api-Secret-Token": secret },
    body: JSON.stringify({ update_id: 1, message: { text, from: { id: user }, chat: { id: user, type: "private" } } }),
  });
}

function context(overrides: WebhookConfig = {}) {
  const sent: string[] = [];
  let calls = 0;
  const handler = createContainerHandler({
    telegramBotToken: "fake-token", webhookSecret: "secret", allowedUserIds: "123",
    internalApiToken: "internal",
    backendHandler: async (req) => {
      calls++;
      assert.equal(req.headers.get("X-Internal-Token"), "internal");
      assert.deepEqual(await req.json(), { text: "Тур" });
      return Response.json({ status: "ready", offer: { client_message: "Готово" } });
    },
    fetchFn: (_url, init) => {
      sent.push(String(init?.body));
      return Promise.resolve(Response.json({ ok: true }));
    },
    ...overrides,
  });
  return { handler, sent, calls: () => calls };
}

Deno.test("container health and routing have no upstream calls", async () => {
  const c = context();
  assert.deepEqual(await (await c.handler(new Request("http://localhost/health"))).json(), { ok: true });
  for (const [path, method, status] of [["/health", "POST", 405], ["/telegram-webhook", "GET", 405], ["/missing", "POST", 404]] as const) {
    assert.equal((await c.handler(new Request(`http://localhost${path}`, { method }))).status, status);
  }
  assert.equal(c.calls(), 0);
  assert.equal(c.sent.length, 0);
});

Deno.test("container POST uses local backend without SUPABASE_URL permission", async () => {
  const c = context();
  assert.equal((await c.handler(request())).status, 200);
  assert.equal(c.calls(), 1);
  assert.equal(c.sent.length, 1);
  assert.ok(c.sent[0].includes("Готово"));
});

Deno.test("container secret and allowlist", async () => {
  const c = context();
  assert.equal((await c.handler(request("Тур", "wrong"))).status, 401);
  assert.equal((await c.handler(request("Тур", "secret", 999))).status, 200);
  assert.equal(c.calls(), 0);
  assert.equal(c.sent.length, 0);
});

Deno.test("container waits for backend and Telegram despite EdgeRuntime", async () => {
  const old = globalThis.EdgeRuntime;
  const backend = Promise.withResolvers<Response>();
  const telegram = Promise.withResolvers<Response>();
  const started = Promise.withResolvers<void>();
  let responded = false;
  globalThis.EdgeRuntime = { waitUntil: () => { throw new Error("Unexpected background mode"); } };
  try {
    const c = context({ backendHandler: () => backend.promise, fetchFn: () => { started.resolve(); return telegram.promise; } });
    const pending = c.handler(request()).then((res) => { responded = true; return res; });
    await Promise.resolve();
    assert.equal(responded, false);
    backend.resolve(Response.json({ status: "ready", offer: { client_message: "Готово" } }));
    await started.promise;
    assert.equal(responded, false);
    telegram.resolve(Response.json({ ok: true }));
    assert.equal((await pending).status, 200);
  } finally { globalThis.EdgeRuntime = old; }
});

Deno.test("backend errors do not reveal secrets", async () => {
  const old = console.error;
  const logs: string[] = [];
  console.error = (...args) => { logs.push(args.join(" ")); };
  try {
    for (const backendHandler of [
      () => Promise.reject(new Error("SECRET_MARKER")),
      () => Promise.resolve(new Response("SECRET_MARKER", { status: 500 })),
    ]) {
      const c = context({ backendHandler });
      const res = await c.handler(request());
      assert.equal(res.status, 200);
      assert.equal(c.sent.length, 1);
      assert.ok(![await res.text(), ...c.sent, ...logs].join().includes("SECRET_MARKER"));
    }
  } finally { console.error = old; }
});

Deno.test("body limit counts exact UTF-8 bytes across chunks and rejects invalid JSON", async () => {
  const c = context();
  const encoder = new TextEncoder();
  for (const [body, expected] of [
    ["{", 400],
    ["null", 400],
    [JSON.stringify({ padding: "я".repeat(32761) }), 200],
    [JSON.stringify({ padding: "я".repeat(32761) + "x" }), 413],
  ] as const) {
    const bytes = encoder.encode(body);
    if (expected !== 400) {
      assert.equal(bytes.length, expected === 200 ? 65536 : 65537);
      assert.ok(body.length < 65536);
    }
    const response = await c.handler(new Request("http://localhost/telegram-webhook", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": "secret" },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          // Split inside the first Cyrillic character as well as near the byte limit.
          controller.enqueue(bytes.slice(0, 13));
          controller.enqueue(bytes.slice(13, 65536));
          controller.enqueue(bytes.slice(65536));
          controller.close();
        },
      }),
    }));
    assert.equal(response.status, expected);
  }
  assert.equal(c.calls(), 0);
  assert.equal(c.sent.length, 0);
});

Deno.test("default local adapter authenticates real text handler and returns exact clarification", async () => {
  const values = {
    OPENROUTER_API_KEY: "test-openrouter-key",
    OPENROUTER_MODEL: "test-model",
    TOURVISOR_JWT: "test.header.signature",
  };
  const previous = new Map(Object.keys(values).map((key) => [key, Deno.env.get(key)]));
  const calls: Array<{ url: string; method?: string; headers: Headers; body: unknown }> = [];
  try {
    for (const [key, value] of Object.entries(values)) Deno.env.set(key, value);
    const c = context({
      backendHandler: undefined,
      internalApiToken: "local-adapter-test-token",
      fetchFn: (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        calls.push({
          url,
          method: init?.method,
          headers: new Headers(init?.headers),
          body: JSON.parse(String(init?.body)),
        });
        if (url === "https://openrouter.ai/api/v1/chat/completions") {
          // Missing departure triggers deterministic validation before dictionary/search calls.
          return Promise.resolve(Response.json({
            choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ departure: "" }) } }],
          }));
        }
        if (url === "https://api.telegram.org/botfake-token/sendMessage") {
          return Promise.resolve(Response.json({ ok: true }));
        }
        throw new Error("Unexpected external request");
      },
    });
    const response = await c.handler(request("Тур"));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.deepEqual(calls.map((call) => call.url), [
      "https://openrouter.ai/api/v1/chat/completions",
      "https://api.telegram.org/botfake-token/sendMessage",
    ]);
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].headers.get("Authorization"), "Bearer test-openrouter-key");
    const parserBody = calls[0].body as { model: string; messages: Array<{ role: string; content: string }> };
    assert.equal(parserBody.model, "test-model");
    assert.deepEqual(parserBody.messages.filter((message) => message.role === "user"), [
      { role: "user", content: "Тур" },
    ]);
    assert.equal(calls[1].method, "POST");
    assert.deepEqual(calls[1].body, {
      chat_id: 123,
      text: "Из какого города планируете вылет?\n\nИсходный запрос: Тур",
      reply_markup: { force_reply: true, selective: true },
    });
    // Authentication and body validation precede the observed OpenRouter call in the real handler.
    // A bad token, exception or generic fallback cannot satisfy these external-call assertions.
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
});

Deno.test("Telegram API failures do not expose response bodies or exception secrets", async () => {
  const previous = console.error;
  const logs: string[] = [];
  console.error = (...args) => { logs.push(args.join(" ")); };
  try {
    for (const failsWithException of [false, true]) {
      let attempts = 0;
      const c = context({
        fetchFn: () => {
          attempts++;
          return failsWithException
            ? Promise.reject(new Error("TELEGRAM_SECRET_MARKER"))
            : Promise.resolve(new Response("TELEGRAM_SECRET_MARKER", { status: 500 }));
        },
      });
      const response = await c.handler(request());
      assert.equal(response.status, 200);
      assert.equal(attempts, 1);
      assert.ok(![await response.text(), ...logs].join().includes("TELEGRAM_SECRET_MARKER"));
    }
    assert.equal(logs.length, 2);
  } finally {
    console.error = previous;
  }
});

Deno.test("port validation", () => {
  assert.equal(containerPort("8080"), 8080);
  for (const value of ["", "0", "65536", "abc", "1.5"]) assert.throws(() => containerPort(value));
});
