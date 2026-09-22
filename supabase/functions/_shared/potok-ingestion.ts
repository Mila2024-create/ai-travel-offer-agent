import type { ParsedRequest } from "./parser/llm-parser.ts";
import type { ValidationResult } from "./parser/validate.ts";

type ParserField = keyof ParsedRequest;
type ConfirmedFacts = Partial<ParsedRequest>;

declare const verifiedPotokPayload: unique symbol;
/** Serialized, contract-verified body. No constructor until the wire contract is known. */
export type SendablePotokPayload = string & { readonly [verifiedPotokPayload]: true };

export type TelegramMetadata = {
  userId?: number;
  chatId?: number;
  messageId?: number;
  /** Telegram message.date, in Unix seconds; never a retry's current time. */
  date?: number;
};

export type PotokDraftInput = {
  eventId: string;
  requestId: string;
  revision: number;
  telegram: TelegramMetadata;
  originalText: string;
  latestText: string;
  parsed: ParsedRequest;
  validation: ValidationResult;
  activeRequest?: boolean;
};

/** Deliberately NOT a sendable Potok event. Parser keys are not Potok field keys. */
export type PotokEventDraft = {
  kind: "contract_pending";
  envelope: {
    event_id: string;
    request_id: string;
    revision: number;
    meaningful: boolean;
    original_text?: string;
    latest_text?: string;
    external_user_id?: string;
    external_chat_id?: string;
    external_message_id?: string;
    occurred_at?: string;
    fields?: never;
    qualification_status?: never;
    assumed_fields?: never;
    missing_fields?: never;
  };
  evidence: {
    confirmed: ConfirmedFacts;
    assumed: ParserField[];
    missing: ParserField[];
  };
  validationPassed: boolean;
};

// TODO(contract): obtain exact Potok fields keys/types and qualification_status enum.
// Only then add a wire serializer mapping evidence and validation to that contract.
// That serializer must return SendablePotokPayload, not a plain JSON string.
// This is a TypeScript boundary, not a restriction on JSON.stringify or generic fetch.

/** SHA-256 based UUIDv8, scoped to this integration. No token or environment access. */
export async function telegramEventId(updateId: number): Promise<string> {
  if (!Number.isSafeInteger(updateId) || updateId < 0) {
    throw new RangeError("Telegram update_id must be a non-negative safe integer");
  }
  const input = new TextEncoder().encode(`AITravelOfferBot:telegram:update:${updateId}`);
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", input)).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${
    hex.slice(20)
  }`;
}

function normalize(text: string): string {
  return text.toLocaleLowerCase("ru").replaceAll("ё", "е").trim();
}

export function isMeaningful(text: string, activeRequest = false): boolean {
  const value = normalize(text);
  if (!value || /^\/(?:start|help)(?:@\w+)?(?:\s|$)/u.test(value)) return false;
  const words = value.replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/gu, " ").trim();
  if (
    /^(?:(?:привет|здравствуйте|здравствуй|спасибо|благодарю|большое|очень|вам|ок|ага|добрый день|доброе утро|добрый вечер|доброй ночи)\s*)+$/u
      .test(words)
  ) {
    return false;
  }
  if (
    /(?:^|\s)(?:не нужен|не нужна|не нужны|не хочу|не хотим|не поедем|не надо)(?:\s|$)/u.test(words)
  ) return false;
  // A small deterministic vocabulary, not a universal destination/NLP classifier.
  const destination =
    /(?:^|\s)(?:египет[ае]?|турци[яюи]|оаэ|таиланд[ае]?|мальдив[ыах]*|сочи)(?:\s|$)/u.test(words);
  const travelNoun =
    /(?:^|\s)(?:тур(?:ы|а|ов)?|путевк[ауи]|отпуск|поездк[ауи]|отдых|отел[ьяеи])(?:\s|$)/u.test(
      words,
    );
  const request =
    /(?:^|\s)(?:хочу|хотим|нужен|нужна|нужны|ищу|ищем|подберите|подобрать|едем|летим)(?:\s|$)/u
      .test(words);
  // Thanks mentioning a past tour are not a new request; an explicit new request may follow.
  if (/(?:^|\s)(?:спасибо|благодарю)(?:\s|$)/u.test(words) && !request) return false;
  const tripDetail =
    /(?:^|\s)(?:январ\p{L}*|феврал\p{L}*|март\p{L}*|апрел\p{L}*|ма[йея]|июн\p{L}*|июл\p{L}*|август\p{L}*|сентябр\p{L}*|октябр\p{L}*|ноябр\p{L}*|декабр\p{L}*|\d+\s+(?:взросл\p{L}*|ноч\p{L}*))(?:\s|$)/u
      .test(words);
  if ((request && (destination || travelNoun)) || (destination && tripDetail)) return true;
  if (/^(?:тур|отпуск|отдых|путевка)$/u.test(words)) return true;
  return activeRequest && (
    /^(?:из|в)\s+\p{L}[\p{L}\s-]*[.!?]?$/u.test(value) ||
    /^(?:нас\s+)?двое\s+взрослых[.!]?$/u.test(value) ||
    /(?:^|\s)\d+\s*(?:взросл\p{L}*|ноч\p{L}*|тысяч\p{L}*|руб\p{L}*)(?:\s|$|[.,!?])/u.test(value) ||
    /^(?:до|бюджет)\s+\d/u.test(value)
  );
}

/** Exact declarative clauses only. Unknown/conditional mentions veto confirmation. */
function explicitCounts(texts: string[], mention: RegExp, declaration: RegExp): (number | null)[] {
  const counts: (number | null)[] = [];
  for (const raw of texts) {
    const text = normalize(raw);
    if (!mention.test(text)) continue;
    // This is uncertainty about the statement, not a numeric qualifier of another field.
    if (
      /[?]|(?:^|\s)(?:если|возможно|может|раньше|ездили|прошлый|прошлом|уточню)(?:\s|[,.]|$)/u.test(
        text,
      )
    ) {
      counts.push(null);
      continue;
    }
    for (const clause of text.split(/[,;.!\n]+/u)) {
      if (!mention.test(clause)) continue;
      const match = declaration.exec(clause.trim());
      counts.push(match ? (match[1] === "двое" ? 2 : Number(match[1])) : null);
    }
  }
  return counts;
}

/** Intentionally narrow evidence recognizers; unrecognized facts remain unconfirmed. */
export function mapParserEvidence(
  parsed: ParsedRequest,
  originalText: string,
  latestText: string,
): PotokEventDraft["evidence"] {
  const text = normalize(`${originalText}\n${latestText}`);
  const confirmed: ConfirmedFacts = {};
  const assumed: ParserField[] = [];
  const missing: ParserField[] = [];
  const adultValues = explicitCounts(
    [originalText, latestText],
    /взросл|состав/u,
    /^(?:(?:едем|нас)\s+)?([1-6]|двое)\s+взросл(?:ых|ый|ая|ого)$/u,
  );
  if (adultValues.length && adultValues.every((n) => n !== null && n === parsed.adults)) {
    confirmed.adults = parsed.adults;
  } else if (
    !adultValues.length &&
    !/взросл|человек|дво|тро|четвер|пятер|шестер|вдвоем|один|одна/u.test(text) &&
    parsed.adults === 2
  ) {
    assumed.push("adults");
  }
  const nightValues = explicitCounts(
    [originalText, latestText],
    /ноч/u,
    /^(?:(?:на|едем на)\s+)?(\d{1,2})\s+ноч(?:ь|и|ей)$/u,
  );
  if (
    nightValues.length && parsed.nights_from > 0 &&
    nightValues.every((n) => n !== null && n === parsed.nights_from && n === parsed.nights_to)
  ) {
    confirmed.nights_from = parsed.nights_from;
    confirmed.nights_to = parsed.nights_to;
  } else if (
    !/ноч|недел|дн[яеи]|день|сут/u.test(text) &&
    parsed.nights_from === 1 && parsed.nights_to === 14
  ) {
    assumed.push("nights_from", "nights_to");
  }
  // Only genuinely absent required values; an invalid value is not automatically missing.
  for (const field of ["departure", "country", "date_from"] as const) {
    if (!parsed[field].trim()) missing.push(field);
  }
  if (parsed.budget == null && parsed.budget_mode === "not_specified") missing.push("budget");
  // TODO(evidence): add conservative recognizers for other parser properties separately.
  // Nonempty parser output alone never confirms a fact or proves an assumption.
  return { confirmed, assumed, missing };
}

export function buildPotokDraft(input: PotokDraftInput): PotokEventDraft {
  if (!input.eventId.trim() || !input.requestId.trim()) {
    throw new TypeError("Event and request identities are required");
  }
  if (!Number.isSafeInteger(input.revision) || input.revision < 1) {
    throw new RangeError("Revision must be a positive safe integer");
  }
  const meaningful = isMeaningful(input.latestText, input.activeRequest);
  // Explicit allowlist: never spread input, parser, validation or Telegram objects.
  const envelope: PotokEventDraft["envelope"] = {
    event_id: input.eventId,
    request_id: input.requestId,
    revision: input.revision,
    meaningful,
  };
  if (meaningful) {
    if (input.originalText.trim()) envelope.original_text = input.originalText;
    if (input.latestText.trim()) envelope.latest_text = input.latestText;
  }
  for (
    const [source, target] of [
      ["userId", "external_user_id"],
      ["chatId", "external_chat_id"],
      ["messageId", "external_message_id"],
    ] as const
  ) {
    const value = input.telegram[source];
    if (value !== undefined) {
      if (!Number.isSafeInteger(value)) throw new RangeError("Invalid Telegram identity");
      envelope[target] = String(value);
    }
  }
  if (input.telegram.date !== undefined) {
    if (!Number.isSafeInteger(input.telegram.date) || input.telegram.date < 0) {
      throw new RangeError("Invalid Telegram date");
    }
    envelope.occurred_at = new Date(input.telegram.date * 1000).toISOString();
  }
  return {
    kind: "contract_pending",
    envelope,
    evidence: meaningful
      ? mapParserEvidence(input.parsed, input.originalText, input.latestText)
      : { confirmed: {}, assumed: [], missing: [] },
    validationPassed: input.validation.ok,
  };
}
