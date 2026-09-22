import assert from "node:assert/strict";
import {
  buildPotokDraft,
  isMeaningful,
  mapParserEvidence,
  type PotokDraftInput,
  type SendablePotokPayload,
  telegramEventId,
} from "../../supabase/functions/_shared/potok-ingestion.ts";
import type { ParsedRequest } from "../../supabase/functions/_shared/parser/llm-parser.ts";

const parsed: ParsedRequest = {
  departure: "",
  country: "",
  date_from: "",
  date_to: "",
  nights_from: 1,
  nights_to: 14,
  adults: 2,
  children_ages: [],
  budget: null,
  budget_mode: "not_specified",
  meal: null,
  hotel_category_min: null,
  hotel_rating_min: null,
};

function input(): PotokDraftInput {
  return {
    eventId: "event",
    requestId: "request",
    revision: 1,
    telegram: { userId: 12, chatId: 34, messageId: 56, date: 1700000000 },
    originalText: "Хочу в Египет",
    latestText: "2 взрослых",
    activeRequest: true,
    parsed: { ...parsed },
    validation: { ok: false, needs_clarification: { field: "departure", question: "Откуда?" } },
  };
}

Deno.test("greetings, thanks and service commands are not meaningful", () => {
  for (
    const text of [
      "",
      "Привет!",
      "Здравствуйте",
      "Добрый день!",
      "Спасибо большое!",
      "Благодарю",
      "/start",
      "/help",
      "/help@TravelBot",
    ]
  ) {
    assert.equal(isMeaningful(text), false, text);
    assert.equal(isMeaningful(text, true), false, text);
  }
});

Deno.test("greeting with travel intent is meaningful", () => {
  assert.equal(isMeaningful("Привет, хочу в Египет в октябре"), true);
  assert.equal(isMeaningful("Спасибо, хотим в Турцию"), true);
});

for (
  const text of ["Спасибо", "Спасибо за тур", "Тур не нужен", "Хочу в кино", "/start", "/help"]
) {
  Deno.test(`meaningful regression rejects: ${text}`, () => {
    assert.equal(isMeaningful(text), false);
    assert.equal(isMeaningful(text, true), false);
  });
}

for (
  const text of [
    "Хочу в Египет",
    "Нужен отель в Египте",
    "Египет в октябре, 2 взрослых",
    "Привет, хочу в Египет в октябре",
  ]
) {
  Deno.test(`meaningful regression accepts: ${text}`, () => {
    assert.equal(isMeaningful(text), true);
  });
}

Deno.test("short clarifications require active request context", () => {
  for (const text of ["из Кирова", "2 взрослых", "до 200 тысяч"]) {
    assert.equal(isMeaningful(text, true), true, text);
    assert.equal(isMeaningful(text), false, text);
  }
});

Deno.test("default adults and nights are assumptions, never confirmed facts", () => {
  const evidence = mapParserEvidence(parsed, "Хочу в Египет", "Хочу в Египет");
  assert.deepEqual(evidence.confirmed, {});
  assert.deepEqual(evidence.assumed, ["adults", "nights_from", "nights_to"]);
});

Deno.test("explicit two adults are confirmed even when equal to parser default", () => {
  const evidence = mapParserEvidence(parsed, "Хочу в Египет", "2 взрослых");
  assert.deepEqual(evidence.confirmed, { adults: 2 });
  assert.equal(evidence.assumed.includes("adults"), false);
});

for (
  const text of [
    "Если поедут 2 взрослых, сколько будет стоить тур?",
    "В прошлый раз ездили 2 взрослых, сейчас состав уточню",
    "Если получится, 2 взрослых",
    "2 взрослых?",
  ]
) {
  Deno.test(`uncertain adults are not confirmed: ${text}`, () => {
    const evidence = mapParserEvidence(parsed, "Хочу тур", text);
    assert.equal(evidence.confirmed.adults, undefined);
    assert.equal(evidence.assumed.includes("adults"), false);
  });
}

for (const text of ["Едем 2 взрослых", "Нас двое взрослых", "2 взрослых, без детей"]) {
  Deno.test(`declarative adults are confirmed: ${text}`, () => {
    const evidence = mapParserEvidence(parsed, "Хочу тур", text);
    assert.equal(evidence.confirmed.adults, 2);
    assert.equal(evidence.assumed.includes("adults"), false);
    assert.equal(buildPotokDraft({ ...input(), latestText: text }).evidence.confirmed.adults, 2);
    assert.equal(
      mapParserEvidence({ ...parsed, adults: 3 }, "Хочу тур", text).confirmed.adults,
      undefined,
    );
  });
}

Deno.test("budget qualifiers do not invalidate adults or nights", () => {
  for (const qualifier of ["до", "от", "примерно"]) {
    assert.equal(
      mapParserEvidence(parsed, "Хочу тур", `2 взрослых, бюджет ${qualifier} 200 тысяч`).confirmed
        .adults,
      2,
    );
    const evidence = mapParserEvidence(
      { ...parsed, nights_from: 7, nights_to: 7 },
      "Хочу тур",
      `7 ночей, бюджет ${qualifier} 200 тысяч`,
    );
    assert.deepEqual(evidence.confirmed, { nights_from: 7, nights_to: 7 });
    assert.equal(
      mapParserEvidence(parsed, "Хочу тур", `${qualifier} 2 взрослых`).confirmed.adults,
      undefined,
    );
  }
});

Deno.test("uncertain nights and contradictory adult clauses are withheld", () => {
  for (const text of ["Если получится, 7 ночей", "В прошлый раз ездили на 7 ночей", "до 7 ночей"]) {
    assert.equal(
      mapParserEvidence({ ...parsed, nights_from: 7, nights_to: 7 }, "Хочу тур", text).confirmed
        .nights_from,
      undefined,
    );
  }
  assert.equal(mapParserEvidence(parsed, "3 взрослых", "2 взрослых").confirmed.adults, undefined);
  assert.equal(
    mapParserEvidence(parsed, "2 взрослых", "примерно 2 взрослых").confirmed.adults,
    undefined,
  );
});

Deno.test("explicit duration is confirmed", () => {
  const evidence = mapParserEvidence(
    { ...parsed, nights_from: 7, nights_to: 7 },
    "Хочу тур",
    "7 ночей",
  );
  assert.deepEqual(evidence.confirmed, { nights_from: 7, nights_to: 7 });
  assert.equal(evidence.assumed.includes("nights_from"), false);
});

Deno.test("negated, contradictory and ranged numbers are not facts", () => {
  for (
    const text of ["не 2 взрослых", "2 взрослых или 3 взрослых", "1-2 взрослых", "от 2 взрослых"]
  ) {
    assert.deepEqual(mapParserEvidence(parsed, "Хочу тур", text).confirmed, {}, text);
  }
});

Deno.test("unrecognized explicit wording is not automatically an assumption", () => {
  const evidence = mapParserEvidence(parsed, "Едем вдвоем на неделю", "Едем вдвоем на неделю");
  assert.deepEqual(evidence.assumed, []);
  assert.deepEqual(evidence.confirmed, {});
});

Deno.test("absent required fields are missing, not assumptions", () => {
  const evidence = mapParserEvidence(parsed, "Хочу тур", "Хочу тур");
  assert.deepEqual(evidence.missing, ["departure", "country", "date_from", "budget"]);
  for (const field of evidence.missing) assert.equal(evidence.assumed.includes(field), false);
  assert.equal(evidence.assumed.includes("meal"), false);
  assert.equal(evidence.missing.includes("meal"), false);
});

Deno.test("parser output without evidence is not copied and no empty facts escape", () => {
  const evidence = mapParserEvidence(
    { ...parsed, country: "Египет", budget_mode: "unknown" },
    "Хочу тур",
    "Хочу тур",
  );
  assert.deepEqual(evidence.confirmed, {});
  assert.equal(evidence.missing.includes("budget"), false);
});

Deno.test("event identity is deterministic and separates updates", async () => {
  const id = await telegramEventId(123456);
  assert.equal(id, await telegramEventId(123456));
  assert.notEqual(id, await telegramEventId(123457));
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  await assert.rejects(() => telegramEventId(-1), RangeError);
  await assert.rejects(() => telegramEventId(1.5), RangeError);
});

Deno.test("contract boundary does not invent fields or qualification values", () => {
  const draft = buildPotokDraft(input());
  assert.equal(draft.kind, "contract_pending");
  assert.equal(draft.validationPassed, false);
  for (const key of ["fields", "qualification_status", "assumed_fields", "missing_fields"]) {
    assert.equal(key in draft.envelope, false);
  }
  // Compile-time guard: a draft envelope is not a sendable, qualified event.
  // @ts-expect-error qualification_status remains unresolved at the contract boundary
  const status: string = draft.envelope.qualification_status;
  void status;
});

Deno.test("only a future contract serializer can produce the branded sendable body", () => {
  const draft = buildPotokDraft(input());
  // These assignments test the public type boundary, without any HTTP implementation.
  // @ts-expect-error a pending draft is not a contract-verified serialized payload
  const fromDraft: SendablePotokPayload = draft;
  // @ts-expect-error extracting the envelope cannot bypass contract verification
  const fromEnvelope: SendablePotokPayload = draft.envelope;
  // @ts-expect-error even a plain serialized envelope lacks the verified brand
  const fromJson: SendablePotokPayload = JSON.stringify(draft.envelope);
  // @ts-expect-error a pending draft cannot directly be an HTTP request body
  const directBody: BodyInit = draft;
  void [fromDraft, fromEnvelope, fromJson, directBody];
});

Deno.test("draft preserves original/latest texts and whitelists Telegram metadata", () => {
  const draft = buildPotokDraft(input());
  assert.deepEqual(draft.envelope, {
    event_id: "event",
    request_id: "request",
    revision: 1,
    meaningful: true,
    original_text: "Хочу в Египет",
    latest_text: "2 взрослых",
    external_user_id: "12",
    external_chat_id: "34",
    external_message_id: "56",
    occurred_at: "2023-11-14T22:13:20.000Z",
  });
});

Deno.test("secrets, Tourvisor responses/searchId and prompts are not copied", () => {
  const contaminated = {
    ...input(),
    secret: "SECRET_SENTINEL",
    botToken: "TOKEN_SENTINEL",
    searchId: "SEARCH_SENTINEL",
    rawTourvisorResponse: { payload: "RAW_SENTINEL" },
    llmPrompt: "PROMPT_SENTINEL",
    parsed: { ...parsed, prompt: "PROMPT_SENTINEL" },
    telegram: { userId: 12, token: "TOKEN_SENTINEL" },
    validation: { ...input().validation, raw: "RAW_SENTINEL" },
  };
  const serialized = JSON.stringify(buildPotokDraft(contaminated));
  assert.doesNotMatch(serialized, /SENTINEL|searchId|botToken|llmPrompt|rawTourvisorResponse/);
});

Deno.test("nonmeaningful update contributes no facts or current text", () => {
  const draft = buildPotokDraft({ ...input(), latestText: "Спасибо!" });
  assert.equal(draft.envelope.meaningful, false);
  assert.deepEqual(draft.evidence, { confirmed: {}, assumed: [], missing: [] });
  assert.equal("latest_text" in draft.envelope, false);
});

Deno.test("invalid revision and identity are rejected", () => {
  assert.throws(() => buildPotokDraft({ ...input(), revision: 0 }), RangeError);
  assert.throws(() => buildPotokDraft({ ...input(), eventId: " " }), TypeError);
});
