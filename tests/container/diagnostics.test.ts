import assert from "node:assert/strict";
import { createContainerHandler } from "../../container/main.ts";
import { classifySafeError, logEntry } from "../../supabase/functions/_shared/diagnostics.ts";
import { startSearch } from "../../supabase/functions/_shared/tourvisor/client.ts";
import { fetchCountries } from "../../supabase/functions/_shared/tourvisor/dictionaries.ts";
import { handleTravelOfferTextRequest } from "../../supabase/functions/travel-offer-text/index.ts";
import type { WebhookConfig } from "../../supabase/functions/telegram-webhook/index.ts";

type Entry = Record<string, unknown>;
function request(updateId: unknown = 17, text = "/start", secret = "secret", user = 123) {
  return new Request("http://localhost/telegram-webhook", {
    method: "POST",
    headers: { "X-Telegram-Bot-Api-Secret-Token": secret },
    body: JSON.stringify({
      update_id: updateId,
      message: { text, chat: { id: 123, type: "private" }, from: { id: user } },
    }),
  });
}
function handler(overrides: WebhookConfig = {}) {
  return createContainerHandler({
    diagnosticsEnabled: true,
    telegramBotToken: "TOKEN_PRIVATE_MARKER",
    webhookSecret: "secret",
    allowedUserIds: "123",
    internalApiToken: "internal",
    fetchFn: () => Promise.resolve(Response.json({ ok: true })),
    backendHandler: () =>
      Promise.resolve(
        Response.json({ status: "ready", offer: { client_message: "MESSAGE_PRIVATE_MARKER" } }),
      ),
    ...overrides,
  });
}
async function capture(run: (entries: Entry[]) => Promise<void>) {
  const old = console.error;
  const entries: Entry[] = [];
  console.error = (line) => entries.push(JSON.parse(String(line)));
  try {
    await run(entries);
  } finally {
    console.error = old;
  }
}
function finished(entries: Entry[]) {
  return entries.filter((e) => e.stage === "webhook" && e.event === "response_ready");
}
function sends(entries: Entry[]) {
  return entries.filter((e) => e.stage === "telegram_api" && e.event === "end");
}

Deno.test("diagnostics: success, HTTP 400/429 and safe network failure preserve HTTP 200", async () => {
  await capture(async (entries) => {
    for (const status of [200, 400, 429]) {
      let attempts = 0;
      const h = handler({
        fetchFn: () => {
          attempts++;
          return Promise.resolve(new Response("BODY_PRIVATE_MARKER", { status }));
        },
      });
      assert.equal((await h(request())).status, 200);
      assert.equal(attempts, 1);
      const last = sends(entries).at(-1)!;
      assert.equal(last.http_status, status);
      assert.equal(last.result, status === 200 ? "http_ok" : "http_error");
      assert.equal(last.send_seq, 1);
      assert.equal(last.update_id, 17);
      assert.ok(Number(last.duration_ms) >= 0);
    }
    const error = new TypeError("URL_PRIVATE_MARKER", {
      cause: Object.assign(new Error("CAUSE_PRIVATE_MARKER"), { code: "ECONNRESET" }),
    });
    const h = handler({ fetchFn: () => Promise.reject(error) });
    assert.equal((await h(request())).status, 200);
    assert.equal(sends(entries).at(-1)!.error, "SEND_FAILED");
    assert.equal(sends(entries).at(-1)!.error_type, "TypeError");
    assert.equal(sends(entries).at(-1)!.error_code, "ECONNRESET");
    assert.equal(finished(entries).at(-1)!.send_failures, 1);
    assert.ok(!JSON.stringify(entries).includes("PRIVATE_MARKER"));
  });
});

Deno.test("diagnostics: pending backend and send do not introduce timeout or early acknowledgement", async () => {
  await capture(async (entries) => {
    const backend = Promise.withResolvers<Response>();
    const send = Promise.withResolvers<Response>();
    const started = Promise.withResolvers<void>();
    let responded = false;
    const h = handler({
      backendHandler: () => backend.promise,
      fetchFn: (_input, init) => {
        assert.equal(init?.signal, undefined);
        started.resolve();
        return send.promise;
      },
    });
    const pending = h(request(18, "MESSAGE_PRIVATE_MARKER")).then((r) => {
      responded = true;
      return r;
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(responded, false);
      assert.ok(entries.some((e) => e.stage === "backend" && e.event === "start"));
      assert.equal(sends(entries).length, 0);
      backend.resolve(Response.json({ status: "ready", offer: { client_message: "reply" } }));
      await started.promise;
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(responded, false);
      assert.equal(finished(entries).length, 0);
    } finally {
      backend.resolve(Response.json({ status: "ready" }));
      send.resolve(Response.json({ ok: true }));
      await pending;
    }
    assert.equal(finished(entries)[0].http_status, 200);
  });
});

Deno.test("diagnostics: failed middle part preserves sequential remaining sends", async () => {
  await capture(async (entries) => {
    let calls = 0;
    let active = 0;
    const h = handler({
      backendHandler: () =>
        Promise.resolve(
          Response.json({ status: "ready", offer: { client_message: "x".repeat(8000) } }),
        ),
      fetchFn: async () => {
        assert.equal(active++, 0);
        calls++;
        await Promise.resolve();
        active--;
        if (calls === 2) throw new Error("PRIVATE_MARKER");
        return Response.json({ ok: true });
      },
    });
    assert.equal((await h(request(19, "tour"))).status, 200);
    assert.equal(calls, 3);
    assert.deepEqual(sends(entries).map((e) => [e.send_seq, e.result]), [[1, "http_ok"], [
      2,
      "exception",
    ], [3, "http_ok"]]);
    assert.equal(finished(entries)[0].send_attempts, 3);
    assert.equal(finished(entries)[0].send_failures, 1);
  });
});

Deno.test("diagnostics: repeated updates have distinct delivery IDs and are not deduplicated", async () => {
  await capture(async (entries) => {
    let attempts = 0;
    const h = handler({
      fetchFn: () => {
        attempts++;
        return Promise.resolve(Response.json({}));
      },
    });
    await h(request(20));
    await h(request(20));
    assert.equal(attempts, 2);
    assert.equal(new Set(finished(entries).map((e) => e.request_id)).size, 2);
    assert.deepEqual(finished(entries).map((e) => e.update_id), [20, 20]);
  });
});

Deno.test("diagnostics: overlapping requests keep IDs, update IDs and counters independent", async () => {
  await capture(async (entries) => {
    const gate = Promise.withResolvers<Response>();
    const started = Promise.withResolvers<void>();
    let calls = 0;
    const h = handler({
      fetchFn: () => {
        if (++calls === 1) {
          started.resolve();
          return gate.promise;
        }
        return Promise.reject(new Error("PRIVATE_MARKER"));
      },
    });
    const first = h(request(21));
    await started.promise;
    try {
      await h(request(22));
    } finally {
      gate.resolve(Response.json({}));
      await first;
    }
    const end = finished(entries);
    assert.equal(new Set(end.map((e) => e.request_id)).size, 2);
    for (const update of [21, 22]) {
      const row = end.find((e) => e.update_id === update)!;
      assert.equal(row.send_attempts, 1);
      assert.equal(row.send_failures, update === 21 ? 0 : 1);
      assert.ok(
        entries.filter((e) => e.request_id === row.request_id)
          .every((e) => e.update_id === undefined || e.update_id === update),
      );
    }
  });
});

Deno.test("diagnostics: disabled mode preserves exact legacy logs and response", async () => {
  await capture(async (entries) => {
    for (const diagnosticsEnabled of [undefined, false]) {
      const h = handler({
        diagnosticsEnabled,
        fetchFn: () => Promise.reject(new Error("PRIVATE_MARKER")),
      });
      assert.deepEqual(await (await h(request())).json(), { ok: true });
    }
    assert.deepEqual(entries, [
      { stage: "telegram_api", error: "SEND_FAILED" },
      { stage: "telegram_api", error: "SEND_FAILED" },
    ]);
  });
});

Deno.test("diagnostics: authentication, allowlist, commands and invalid update IDs", async () => {
  await capture(async (entries) => {
    let backendCalls = 0;
    let sendCalls = 0;
    const h = handler({
      backendHandler: () => {
        backendCalls++;
        return Promise.resolve(Response.json({ status: "ready" }));
      },
      fetchFn: () => {
        sendCalls++;
        return Promise.resolve(Response.json({}));
      },
    });
    assert.equal((await h(request(1, "/start", "wrong"))).status, 401);
    assert.equal((await h(request(1, "/start", "secret", 999))).status, 200);
    assert.equal(sendCalls, 0);
    for (const id of ["PRIVATE_MARKER", -1, 1.5, Number.MAX_SAFE_INTEGER + 1, null]) {
      await h(request(id, "/help"));
      assert.equal(finished(entries).at(-1)!.update_id, undefined);
    }
    await h(request(0));
    assert.equal(finished(entries).at(-1)!.update_id, 0);
    assert.equal(backendCalls, 0);
    assert.equal(sendCalls, 6);
    assert.ok(!JSON.stringify(entries).includes("PRIVATE_MARKER"));
  });
});

Deno.test("diagnostics: closed schema filters legacy backend logs, arbitrary errors and upstream fields", async () => {
  await capture(async (entries) => {
    const h = handler({
      backendHandler: async () => {
        logEntry({
          stage: "PRIVATE_MARKER",
          error: "PRIVATE_MARKER",
          request_id: "PRIVATE_MARKER",
          departure: "PRIVATE_MARKER",
          message: "PRIVATE_MARKER",
          stack: "PRIVATE_MARKER",
          headers: { Authorization: "PRIVATE_MARKER" },
          body: "PRIVATE_MARKER",
        });
        await fetchCountries(1, "JWT_PRIVATE_MARKER", () => Promise.resolve(Response.json([])));
        await assert.rejects(() =>
          startSearch({
            departure_id: 1,
            country_id: 1,
            date_from: "2027-01-01",
            date_to: "2027-01-02",
            nights_from: 7,
            nights_to: 7,
            adults: 2,
            currency: "RUB",
            charter_only: true,
          }, {
            jwt: "JWT_PRIVATE_MARKER",
            fetchFn: () =>
              Promise.resolve(Response.json({
                code: "PRIVATE_MARKER",
                error: "PRIVATE_MARKER",
                message: "PRIVATE_MARKER",
                detail: "PRIVATE_MARKER",
                details: "PRIVATE_MARKER",
              }, { status: 400 })),
          })
        );
        return Response.json({ status: "ready", offer: { client_message: "PRIVATE_MARKER" } });
      },
      fetchFn: () =>
        Promise.reject(Object.assign(new Error("PRIVATE_MARKER"), {
          name: "PRIVATE_MARKER",
          code: "PRIVATE_MARKER",
          cause: { code: "PRIVATE_MARKER" },
        })),
    });
    await h(request(30, "PRIVATE_MARKER"));
    assert.equal(sends(entries)[0].error_type, "unknown");
    assert.equal(sends(entries)[0].error_code, "unknown");
    assert.ok(!JSON.stringify(entries).includes("PRIVATE_MARKER"));
    assert.ok(entries.every((e) =>
      Object.keys(e).every((key) =>
        [
          "timestamp",
          "request_id",
          "update_id",
          "stage",
          "event",
          "result",
          "error",
          "error_type",
          "error_code",
          "http_status",
          "duration_ms",
          "send_seq",
          "send_attempts",
          "send_failures",
        ].includes(key)
      )
    ));
  });
});

Deno.test("diagnostics: safe classifier tolerates hostile getters and raw thrown values", () => {
  const error = Object.defineProperty({}, "name", {
    get() {
      throw new Error("PRIVATE_MARKER");
    },
  });
  assert.deepEqual(classifySafeError(error), { error_type: "unknown", error_code: "unknown" });
  assert.deepEqual(classifySafeError("PRIVATE_MARKER"), {
    error_type: "unknown",
    error_code: "unknown",
  });
});

Deno.test("diagnostics: logger failure does not alter HTTP response", async () => {
  const old = console.error;
  console.error = () => {
    throw new Error("logger unavailable");
  };
  try {
    assert.equal((await handler()(request())).status, 200);
  } finally {
    console.error = old;
  }
});

Deno.test("diagnostics: prepared HTTP 500 is recorded for unexpected update failure", async () => {
  await capture(async (entries) => {
    const req = new Request("http://localhost/telegram-webhook", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": "secret" },
      body: JSON.stringify({ update_id: 31, message: { text: "text", chat: { type: "private" } } }),
    });
    // Simulate an unexpected configuration error outside handled send/backend failures.
    const h = handler({ allowedUserIds: 123 as unknown as string });
    assert.equal((await h(req)).status, 500);
    assert.equal(finished(entries)[0].http_status, 500);
    assert.equal(finished(entries)[0].update_id, 31);
  });
});

Deno.test("diagnostics: real text handler logs are filtered in the same async context", async () => {
  const keys = ["OPENROUTER_API_KEY", "OPENROUTER_MODEL", "TOURVISOR_JWT"];
  const old = keys.map((key) => Deno.env.get(key));
  try {
    Deno.env.set(keys[0], "KEY_PRIVATE_MARKER");
    Deno.env.set(keys[1], "MODEL_PRIVATE_MARKER");
    Deno.env.set(keys[2], "fake.header.signature");
    await capture(async (entries) => {
      const h = handler({
        backendHandler: (req) =>
          handleTravelOfferTextRequest(req, {
            internalApiToken: "internal",
            fetchFn: () =>
              Promise.resolve(Response.json({
                choices: [{
                  message: { content: JSON.stringify({ departure: "PRIVATE_MARKER" }) },
                  finish_reason: "stop",
                }],
              })),
          }),
      });
      await h(request(32, "PRIVATE_MARKER"));
      assert.ok(entries.some((e) => e.stage === "parsed"));
      assert.ok(!JSON.stringify(entries).includes("PRIVATE_MARKER"));
    });
  } finally {
    keys.forEach((key, i) =>
      old[i] === undefined ? Deno.env.delete(key) : Deno.env.set(key, old[i]!)
    );
  }
});
