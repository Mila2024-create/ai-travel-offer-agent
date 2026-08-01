import type { ParsedRequest } from "./llm-parser.ts";
import { DictionaryResolver } from "../tourvisor/dictionaries.ts";
import type { SpikeRequest } from "../spike/types.ts";

export type ClarificationQuestion = {
  field: string;
  question: string;
};

export type ValidationResult = {
  ok: true;
  request: SpikeRequest;
  resolved: {
    departure: { id: number; name: string };
    country: { id: number; name: string };
    meal: { id: number; name: string } | null;
  };
} | {
  ok: false;
  needs_clarification: ClarificationQuestion;
};

const CRITICAL_FIELDS: Array<{ field: keyof ParsedRequest; question: string }> = [
  { field: "departure", question: "Из какого города планируете вылет?" },
  { field: "country", question: "В какую страну хотите поехать?" },
  { field: "date_from", question: "На какие даты планируете тур?" },
];

export async function validateAndResolve(
  parsed: ParsedRequest,
  resolver: DictionaryResolver,
  currentDate = new Date(),
): Promise<ValidationResult> {
  for (const { field, question } of CRITICAL_FIELDS) {
    const val = parsed[field];
    if (!val || (typeof val === "string" && val.trim().length === 0)) {
      return { ok: false, needs_clarification: { field: field as string, question } };
    }
  }

  const today = currentDate.toISOString().slice(0, 10);
  if (parsed.date_from < today || parsed.date_to < today) {
    return {
      ok: false,
      needs_clarification: {
        field: "date_from",
        question: "Указанная дата уже прошла. Уточните будущую дату поездки.",
      },
    };
  }

  if (parsed.budget_mode === "not_specified" && parsed.budget == null) {
    return {
      ok: false,
      needs_clarification: {
        field: "budget",
        question: "Какой ориентир по бюджету на весь тур?",
      },
    };
  }

  const departure = await resolver.resolveDeparture(parsed.departure);
  if (!departure) {
    return {
      ok: false,
      needs_clarification: {
        field: "departure",
        question: `Город вылета "${parsed.departure}" не найден. Уточните город отправления.`,
      },
    };
  }

  const country = await resolver.resolveCountry(departure.id, parsed.country);
  if (!country) {
    return {
      ok: false,
      needs_clarification: {
        field: "country",
        question: `Страна "${parsed.country}" не найдена для вылета из ${departure.name}. Уточните страну назначения.`,
      },
    };
  }

  let resolvedMeal: { id: number; name: string } | null = null;
  if (parsed.meal) {
    resolvedMeal = await resolver.resolveMeal(parsed.meal);
    if (!resolvedMeal) {
      return {
        ok: false,
        needs_clarification: {
          field: "meal",
          question: `Тип питания "${parsed.meal}" не найден. Уточните предпочтения по питанию (AI, HB, BB, FB).`,
        },
      };
    }
  }

  const request: SpikeRequest = {
    departure_id: departure.id,
    country_id: country.id,
    date_from: parsed.date_from,
    date_to: parsed.date_to,
    nights_from: parsed.nights_from,
    nights_to: parsed.nights_to,
    adults: parsed.adults,
    children_ages: parsed.children_ages,
    budget_max: parsed.budget_mode === "unknown" ? null : parsed.budget,
    budget_mode: parsed.budget_mode === "not_specified" ? "unknown" : parsed.budget_mode,
    meal: resolvedMeal?.name ?? null,
    meal_id: resolvedMeal?.id ?? null,
    hotel_category_min: parsed.hotel_category_min,
    hotel_rating_min: parsed.hotel_rating_min,
  };

  return {
    ok: true,
    request,
    resolved: {
      departure: { id: departure.id, name: departure.name },
      country: { id: country.id, name: country.name },
      meal: resolvedMeal,
    },
  };
}
