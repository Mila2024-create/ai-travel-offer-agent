import assert from "node:assert/strict";
import {
  ParserConfigError,
  parseText,
} from "../../supabase/functions/_shared/parser/llm-parser.ts";
import type { ParsedRequest } from "../../supabase/functions/_shared/parser/llm-parser.ts";
import { validateAndResolve } from "../../supabase/functions/_shared/parser/validate.ts";
import { DictionaryResolver } from "../../supabase/functions/_shared/tourvisor/dictionaries.ts";
import { handleTravelOfferTextRequest } from "../../supabase/functions/travel-offer-text/index.ts";
import type { HandlerConfig } from "../../supabase/functions/travel-offer-text/index.ts";
import departures from "../fixtures/tourvisor/departures.json" with { type: "json" };
import countries from "../fixtures/tourvisor/countries.json" with { type: "json" };
import meals from "../fixtures/tourvisor/meals.json" with { type: "json" };

function mockDictFetch(): typeof fetch {
  return (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const map: Record<string, unknown> = {
      "/departures": departures,
      "/countries": countries,
      "/meals": meals,
    };
    for (const [pattern, data] of Object.entries(map)) {
      if (url.includes(pattern)) {
        return Promise.resolve(
          new Response(JSON.stringify(data), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }
    }
    return Promise.resolve(
      new Response("[]", { status: 200, headers: { "content-type": "application/json" } }),
    );
  };
}

function mockOpenRouter(content: unknown, finishReason = "stop"): typeof fetch {
  return (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
    return Promise.resolve(
      new Response(
        JSON.stringify({
          id: "mock",
          choices: [{ message: { content: JSON.stringify(content) }, finish_reason: finishReason }],
          model: body.model ?? "mock",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  };
}

const CURRENT_DATE = new Date("2026-07-01T00:00:00Z");

const VALID_PARSED = {
  departure: "Москва",
  country: "Турция",
  date_from: "2026-08-01",
  date_to: "2026-08-21",
  nights_from: 7,
  nights_to: 14,
  adults: 2,
  children_ages: [],
  budget: 100000,
  budget_mode: "soft" as const,
  meal: "AI",
  hotel_category_min: null,
  hotel_rating_min: null,
};

Deno.test("1. parser returns validated structure", async () => {
  const origKey = Deno.env.get("OPENROUTER_API_KEY");
  const origModel = Deno.env.get("OPENROUTER_MODEL");
  try {
    Deno.env.set("OPENROUTER_API_KEY", "test-key");
    Deno.env.set("OPENROUTER_MODEL", "test-model");
    const result = await parseText(
      "турция из москвы на август",
      mockOpenRouter(VALID_PARSED),
      CURRENT_DATE,
    );
    assert.strictEqual(result.departure, "Москва");
    assert.strictEqual(result.country, "Турция");
    assert.strictEqual(result.date_from, "2026-08-01");
    assert.strictEqual(result.date_to, "2026-08-21");
    assert.strictEqual(result.adults, 2);
    assert.deepStrictEqual(result.children_ages, []);
    assert.strictEqual(result.budget, 100000);
    assert.strictEqual(result.budget_mode, "soft");
    assert.strictEqual(result.meal, "AI");
  } finally {
    if (origKey) Deno.env.set("OPENROUTER_API_KEY", origKey);
    else Deno.env.delete("OPENROUTER_API_KEY");
    if (origModel) Deno.env.set("OPENROUTER_MODEL", origModel);
    else Deno.env.delete("OPENROUTER_MODEL");
  }
});

Deno.test("2. finish_reason=length throws truncated error before JSON.parse", async () => {
  const origKey = Deno.env.get("OPENROUTER_API_KEY");
  const origModel = Deno.env.get("OPENROUTER_MODEL");
  try {
    Deno.env.set("OPENROUTER_API_KEY", "test-key");
    Deno.env.set("OPENROUTER_MODEL", "test-model");
    await parseText("турция из москвы", mockOpenRouter({}, "length"), CURRENT_DATE);
    assert.fail("Expected error");
  } catch (e) {
    const msg = (e as Error).message;
    assert.ok(msg.includes("truncated"), `expected truncated error, got: ${msg}`);
  } finally {
    if (origKey) Deno.env.set("OPENROUTER_API_KEY", origKey);
    else Deno.env.delete("OPENROUTER_API_KEY");
    if (origModel) Deno.env.set("OPENROUTER_MODEL", origModel);
    else Deno.env.delete("OPENROUTER_MODEL");
  }
});

Deno.test("date without year uses nearest future year", async () => {
  const origKey = Deno.env.get("OPENROUTER_API_KEY");
  const origModel = Deno.env.get("OPENROUTER_MODEL");
  try {
    Deno.env.set("OPENROUTER_API_KEY", "test-key");
    Deno.env.set("OPENROUTER_MODEL", "test-model");
    const llmResult = { ...VALID_PARSED, date_from: "2025-09-10", date_to: "2025-09-19" };
    let systemPrompt = "";
    const dateFetch: typeof fetch = (input, init) => {
      const requestBody = JSON.parse(String(init?.body ?? "{}"));
      systemPrompt = String(requestBody.messages?.[0]?.content ?? "");
      return mockOpenRouter(llmResult)(input, init);
    };

    const september2026 = await parseText(
      "Из Москвы в Турцию с 10 сентября на 10 дней 2 взрослых",
      dateFetch,
      new Date("2026-08-01T00:00:00Z"),
    );
    assert.strictEqual(september2026.date_from, "2026-09-10");
    assert.strictEqual(september2026.date_to, "2026-09-19");
    assert.ok(systemPrompt.includes("Текущая дата: 2026-08-01"));

    const september2027 = await parseText(
      "Из Москвы в Турцию с 10 сентября на 10 дней 2 взрослых",
      mockOpenRouter(llmResult),
      new Date("2026-10-01T00:00:00Z"),
    );
    assert.strictEqual(september2027.date_from, "2027-09-10");
    assert.strictEqual(september2027.date_to, "2027-09-19");
  } finally {
    if (origKey) Deno.env.set("OPENROUTER_API_KEY", origKey);
    else Deno.env.delete("OPENROUTER_API_KEY");
    if (origModel) Deno.env.set("OPENROUTER_MODEL", origModel);
    else Deno.env.delete("OPENROUTER_MODEL");
  }
});

Deno.test("explicit past year returns date clarification before Tourvisor", async () => {
  const parsed = { ...VALID_PARSED, date_from: "2025-09-10", date_to: "2025-09-19" };
  let externalCalls = 0;
  const resolver = new DictionaryResolver("jwt", () => {
    externalCalls += 1;
    return Promise.reject(new Error("external call must not happen"));
  });
  const result = await validateAndResolve(parsed, resolver, new Date("2026-08-01T00:00:00Z"));
  assert.strictEqual(result.ok, false);
  if (!result.ok) {
    assert.strictEqual(result.needs_clarification.field, "date_from");
    assert.ok(result.needs_clarification.question.includes("прошла"));
  }
  assert.strictEqual(externalCalls, 0);
});

Deno.test("3. missing budget returns one clarification question", async () => {
  const parsed = { ...VALID_PARSED, budget: null, budget_mode: "not_specified" as const };
  const resolver = new DictionaryResolver("jwt", mockDictFetch());
  const result = await validateAndResolve(parsed, resolver, CURRENT_DATE);
  assert.strictEqual(result.ok, false);
  if (!result.ok) {
    assert.strictEqual(result.needs_clarification.field, "budget");
    assert.ok(result.needs_clarification.question.includes("бюджет"));
  }
});

Deno.test("3. explicit no-limit gives budget_mode=unknown", async () => {
  const parsed = { ...VALID_PARSED, budget: null, budget_mode: "unknown" as const };
  const resolver = new DictionaryResolver("jwt", mockDictFetch());
  const result = await validateAndResolve(parsed, resolver, CURRENT_DATE);
  assert.strictEqual(result.ok, true);
  if (result.ok) {
    assert.strictEqual(result.request.budget_max, null);
    assert.strictEqual(result.request.budget_mode, "unknown");
  }
});

Deno.test("4. departure/country/meal resolve to fixture IDs", async () => {
  const parsed = { ...VALID_PARSED, budget: null, budget_mode: "unknown" as const };
  const resolver = new DictionaryResolver("jwt", mockDictFetch());
  const result = await validateAndResolve(parsed, resolver, CURRENT_DATE);
  assert.strictEqual(result.ok, true);
  if (result.ok) {
    assert.strictEqual(result.resolved.departure.id, 1);
    assert.strictEqual(result.resolved.departure.name, "Москва");
    assert.strictEqual(result.resolved.country.id, 10);
    assert.strictEqual(result.resolved.country.name, "Турция");
    assert.strictEqual(result.resolved.meal!.id, 100);
    assert.strictEqual(result.resolved.meal!.name, "AI");
  }
});

Deno.test("5. unknown dictionary returns clarification, no searchTours", async () => {
  const parsed = { ...VALID_PARSED, country: "Марс" };
  const resolver = new DictionaryResolver("jwt", mockDictFetch());
  const result = await validateAndResolve(parsed, resolver, CURRENT_DATE);
  assert.strictEqual(result.ok, false);
  if (!result.ok) {
    assert.strictEqual(result.needs_clarification.field, "country");
    assert.ok(result.needs_clarification.question.includes("Марс"));
  }
});

Deno.test("6. missing OPENROUTER_MODEL throws ParserConfigError without secrets", async () => {
  const origModel = Deno.env.get("OPENROUTER_MODEL");
  const origKey = Deno.env.get("OPENROUTER_API_KEY");
  try {
    Deno.env.set("OPENROUTER_API_KEY", "test-key");
    Deno.env.delete("OPENROUTER_MODEL");
    await parseText("test", undefined, CURRENT_DATE);
    assert.fail("Expected error");
  } catch (e) {
    assert.ok(e instanceof ParserConfigError);
    const msg = (e as Error).message;
    assert.ok(msg.includes("OPENROUTER_MODEL"));
    assert.ok(!msg.includes("test-key"));
  } finally {
    if (origModel) Deno.env.set("OPENROUTER_MODEL", origModel);
    else Deno.env.delete("OPENROUTER_MODEL");
    if (origKey) Deno.env.set("OPENROUTER_API_KEY", origKey);
    else Deno.env.delete("OPENROUTER_API_KEY");
  }
});

Deno.test("8. soft budget sends priceTo * 1.1 to Tourvisor, hard sends exact", async () => {
  const origKey = Deno.env.get("OPENROUTER_API_KEY");
  const origModel = Deno.env.get("OPENROUTER_MODEL");
  try {
    Deno.env.set("OPENROUTER_API_KEY", "test-key");
    Deno.env.set("OPENROUTER_MODEL", "test-model");

    const tourvisorBodies: Array<{ priceTo?: number }> = [];

    function makeFetch(parsedOverride: Partial<ParsedRequest>) {
      return (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("openrouter.ai")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                id: "m",
                choices: [{
                  message: { content: JSON.stringify({ ...VALID_PARSED, ...parsedOverride }) },
                  finish_reason: "stop",
                }],
                model: "m",
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          );
        }
        if (url.includes("/departures")) {
          return Promise.resolve(
            new Response(JSON.stringify(departures), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          );
        }
        if (url.includes("/countries")) {
          return Promise.resolve(
            new Response(JSON.stringify(countries), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          );
        }
        if (url.includes("/meals")) {
          return Promise.resolve(
            new Response(JSON.stringify(meals), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          );
        }
        if (url.includes("/tours/search")) {
          const isStart = !url.includes("/status") && !/\/(\d+)$/.test(url.split("?")[0]);
          if (isStart) {
            const priceTo = new URL(url).searchParams.get("priceTo");
            tourvisorBodies.push(priceTo == null ? {} : { priceTo: Number(priceTo) });
            return Promise.resolve(
              new Response(JSON.stringify({ searchId: 42 }), {
                status: 200,
                headers: { "content-type": "application/json" },
              }),
            );
          }
          if (url.includes("/status")) {
            return Promise.resolve(
              new Response(JSON.stringify({ searchId: 42, status: "completed", progress: 100 }), {
                status: 200,
                headers: { "content-type": "application/json" },
              }),
            );
          }
          return Promise.resolve(
            new Response(
              JSON.stringify([{
                id: 1,
                name: "Hotel A",
                country: { id: 10, name: "Турция" },
                region: { id: 1, name: "Antalya" },
                category: 5,
                rating: 4.5,
                tours: [{
                  id: "t1",
                  price: 80000,
                  date: "2026-08-10",
                  nights: 7,
                  meal: { id: 100, name: "AI" },
                  roomType: "Standard",
                  operator: { id: 1, name: "Op" },
                  currency: "RUB",
                }],
              }]),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          );
        }
        return Promise.resolve(
          new Response("[]", { status: 200, headers: { "content-type": "application/json" } }),
        );
      };
    }

    const config: HandlerConfig = {
      currentDate: CURRENT_DATE,
      internalApiToken: "tok",
      tourvisorJwt: "eyJhbGciOiJIUzI1NiJ9.eyJ0ZXN0IjoidGVzdCJ9.test",
      fetchFn: makeFetch({ budget: 300000, budget_mode: "soft" as const }),
      sleepFn: () => Promise.resolve(),
    };
    const req = new Request("http://localhost/travel-offer-text", {
      method: "POST",
      headers: { "X-Internal-Token": "tok" },
      body: JSON.stringify({ text: "турция из москвы на август, бюджет 300к" }),
    });
    await handleTravelOfferTextRequest(req, config);
    const startBody = tourvisorBodies.find((b) => b.priceTo !== undefined);
    assert.ok(startBody, "expected a Tourvisor search request with priceTo");
    assert.strictEqual(startBody!.priceTo, 330000, "soft budget 300000 should send priceTo=330000");

    tourvisorBodies.length = 0;
    const configHard: HandlerConfig = {
      currentDate: CURRENT_DATE,
      internalApiToken: "tok",
      tourvisorJwt: "eyJhbGciOiJIUzI1NiJ9.eyJ0ZXN0IjoidGVzdCJ9.test",
      fetchFn: makeFetch({ budget: 300000, budget_mode: "hard" as const }),
      sleepFn: () => Promise.resolve(),
    };
    const reqHard = new Request("http://localhost/travel-offer-text", {
      method: "POST",
      headers: { "X-Internal-Token": "tok" },
      body: JSON.stringify({ text: "турция из москвы на август, бюджет 300к" }),
    });
    await handleTravelOfferTextRequest(reqHard, configHard);
    const startBodyHard = tourvisorBodies.find((b) => b.priceTo !== undefined);
    assert.ok(startBodyHard, "expected a Tourvisor search request with priceTo");
    assert.strictEqual(startBodyHard!.priceTo, 300000, "hard budget 300000 should send priceTo=300000");

    tourvisorBodies.length = 0;
    const configUnknown: HandlerConfig = {
      currentDate: CURRENT_DATE,
      internalApiToken: "tok",
      tourvisorJwt: "eyJhbGciOiJIUzI1NiJ9.eyJ0ZXN0IjoidGVzdCJ9.test",
      fetchFn: makeFetch({ budget: null, budget_mode: "unknown" as const }),
      sleepFn: () => Promise.resolve(),
    };
    const reqUnknown = new Request("http://localhost/travel-offer-text", {
      method: "POST",
      headers: { "X-Internal-Token": "tok" },
      body: JSON.stringify({ text: "турция из москвы на август, бюджет не важен" }),
    });
    await handleTravelOfferTextRequest(reqUnknown, configUnknown);
    assert.strictEqual(tourvisorBodies.length, 1, "expected one Tourvisor search start");
    assert.strictEqual(tourvisorBodies[0].priceTo, undefined, "unknown/null budget should omit priceTo");
  } finally {
    if (origKey) Deno.env.set("OPENROUTER_API_KEY", origKey);
    else Deno.env.delete("OPENROUTER_API_KEY");
    if (origModel) Deno.env.set("OPENROUTER_MODEL", origModel);
    else Deno.env.delete("OPENROUTER_MODEL");
  }
});

Deno.test("7. endpoint ready passes through pipeline and returns top-3", async () => {
  const origKey = Deno.env.get("OPENROUTER_API_KEY");
  const origModel = Deno.env.get("OPENROUTER_MODEL");
  try {
    Deno.env.set("OPENROUTER_API_KEY", "test-key");
    Deno.env.set("OPENROUTER_MODEL", "test-model");
    const config: HandlerConfig = {
      currentDate: CURRENT_DATE,
      internalApiToken: "tok",
      tourvisorJwt: "eyJhbGciOiJIUzI1NiJ9.eyJ0ZXN0IjoidGVzdCJ9.test",
      fetchFn: (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("openrouter.ai")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                id: "m",
                choices: [{
                  message: { content: JSON.stringify(VALID_PARSED) },
                  finish_reason: "stop",
                }],
                model: "m",
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          );
        }
        if (url.includes("/departures")) {
          return Promise.resolve(
            new Response(JSON.stringify(departures), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          );
        }
        if (url.includes("/countries")) {
          return Promise.resolve(
            new Response(JSON.stringify(countries), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          );
        }
        if (url.includes("/meals")) {
          return Promise.resolve(
            new Response(JSON.stringify(meals), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          );
        }
        if (url.includes("/tours/search")) {
          const isStart = !url.includes("/status") && !/\/(\d+)$/.test(url.split("?")[0]);
          if (isStart) {
            return Promise.resolve(
              new Response(JSON.stringify({ searchId: 42 }), {
                status: 200,
                headers: { "content-type": "application/json" },
              }),
            );
          }
          if (url.includes("/status")) {
            return Promise.resolve(
              new Response(JSON.stringify({ searchId: 42, status: "completed", progress: 100 }), {
                status: 200,
                headers: { "content-type": "application/json" },
              }),
            );
          }
          return Promise.resolve(
            new Response(
              JSON.stringify([{
                id: 1,
                name: "Hotel A",
                country: { id: 10, name: "Турция" },
                region: { id: 1, name: "Antalya" },
                category: 5,
                rating: 4.5,
                tours: [{
                  id: "t1",
                  price: 80000,
                  date: "2026-08-10",
                  nights: 7,
                  meal: { id: 100, name: "AI" },
                  roomType: "Standard",
                  operator: { id: 1, name: "Op" },
                  currency: "RUB",
                }],
              }]),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          );
        }
        return Promise.resolve(
          new Response("[]", { status: 200, headers: { "content-type": "application/json" } }),
        );
      },
      sleepFn: () => Promise.resolve(),
    };

    const req = new Request("http://localhost/travel-offer-text", {
      method: "POST",
      headers: { "X-Internal-Token": "tok" },
      body: JSON.stringify({ text: "турция из москвы на август, бюджет 100к" }),
    });

    const res = await handleTravelOfferTextRequest(req, config);
    assert.strictEqual(res.status, 200);
    const json = await res.json();
    assert.strictEqual(json.status, "ready");
    assert.ok(json.parsed_request);
    assert.ok(json.resolved_request);
    assert.ok(json.offer);
    assert.ok(Array.isArray(json.offer.ranked_tours));
    assert.ok(json.offer.ranked_tours.length >= 1);
    assert.ok(json.offer.ranked_tours.length <= 3);
    assert.strictEqual(typeof json.offer.agent_summary, "string");
    assert.strictEqual(typeof json.offer.client_message, "string");
  } finally {
    if (origKey) Deno.env.set("OPENROUTER_API_KEY", origKey);
    else Deno.env.delete("OPENROUTER_API_KEY");
    if (origModel) Deno.env.set("OPENROUTER_MODEL", origModel);
    else Deno.env.delete("OPENROUTER_MODEL");
  }
});
