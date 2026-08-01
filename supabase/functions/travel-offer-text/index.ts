import { type ParsedRequest, ParserConfigError, parseText } from "../_shared/parser/llm-parser.ts";
import { validateAndResolve } from "../_shared/parser/validate.ts";
import { DictionaryResolver } from "../_shared/tourvisor/dictionaries.ts";
import { searchTours, type TourCandidate, TourvisorError } from "../_shared/tourvisor/client.ts";
import { TourvisorSearchParamsSchema } from "../_shared/schemas/tourvisor.ts";
import { runPipelineWithCandidates } from "../_shared/spike/pipeline.ts";
import { buildOffer } from "../_shared/spike/build-offer.ts";
import type { SpikeRequest, SpikeTour } from "../_shared/spike/types.ts";

export type HandlerConfig = {
  internalApiToken?: string;
  tourvisorJwt?: string;
  fetchFn?: typeof fetch;
  sleepFn?: (ms: number) => Promise<void>;
};

type TextRequestBody = {
  text: string;
};

type LogEntry = {
  stage: string;
  error_name?: string;
  error_code?: string;
  http_status?: number;
  response_type?: string;
  item_count?: number;
  [key: string]: unknown;
};

function safeLog(entry: LogEntry): void {
  console.error(JSON.stringify(entry));
}

function tourCandidateToSpikeTour(candidates: TourCandidate[], countryId: number): SpikeTour[] {
  return candidates.map((c) => ({
    hotel_id: c.hotel_id,
    hotel_name: c.hotel_name ?? "",
    country_id: countryId,
    country: c.country ?? "",
    resort: c.resort ?? "",
    hotel_category: c.hotel_category ?? 0,
    hotel_rating: c.hotel_rating ?? 0,
    distance_to_sea: 0,
    tour_id: c.tour_id,
    departure_date: c.departure_date ?? "",
    nights: c.nights ?? 0,
    meal: c.meal ?? "",
    room: c.room ?? "",
    tour_operator: c.tour_operator ?? "",
    price: c.price,
    currency: c.currency ?? "RUB",
    hotel_availability: c.hotel_availability ?? "unknown",
    flight_availability: c.flight_availability ?? "unknown",
  }));
}

function json(data: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export async function handleTravelOfferTextRequest(
  request: Request,
  config?: HandlerConfig,
): Promise<Response> {
  const expectedToken = config?.internalApiToken ?? Deno.env.get("INTERNAL_API_TOKEN");
  if (!expectedToken) {
    return json({ error: "Server configuration error" }, 500);
  }
  const providedToken = request.headers.get("X-Internal-Token");
  if (providedToken !== expectedToken) {
    return json({ error: "Unauthorized" }, 401);
  }

  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  let body: TextRequestBody;
  try {
    body = await request.json() as TextRequestBody;
  } catch {
    return json({ error: "Invalid request body" }, 400);
  }

  if (typeof body.text !== "string" || body.text.trim().length === 0) {
    return json({ error: "Invalid request body: text is required" }, 400);
  }

  let parsed: ParsedRequest;
  try {
    parsed = await parseText(body.text, config?.fetchFn);
    safeLog({ stage: "parsed", departure: parsed.departure });
  } catch (e) {
    if (e instanceof ParserConfigError) {
      safeLog({ stage: "openrouter", error_name: "ParserConfigError", error_code: "CONFIG_ERROR" });
      return json({ error: "Server configuration error" }, 500);
    }
    const err = e as Error;
    safeLog({ stage: "openrouter", error_name: err.name, error_code: "OPENROUTER_ERROR" });
    return json({ error: "Failed to parse request" }, 502);
  }

  const rawJwt = config?.tourvisorJwt ?? Deno.env.get("TOURVISOR_JWT");
  const jwt = rawJwt?.trim();
  const jwtIsValid = jwt != null && jwt.length > 0 &&
    !/[\r\n]/.test(jwt) &&
    /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(jwt);

  if (!jwtIsValid) {
    safeLog({ stage: "tour_search", error_name: "JwtValidationError", error_code: "INVALID_JWT" });
    return json({
      status: "error",
      error_code: "TOUR_SOURCE_ERROR",
      message: "Tourvisor JWT not configured.",
    }, 502);
  }

  const resolver = new DictionaryResolver(jwt, config?.fetchFn);

  let validation;
  try {
    validation = await validateAndResolve(parsed, resolver);
  } catch (e) {
    const err = e as Error;
    safeLog({
      stage: e instanceof TourvisorError ? e.stage ?? "dictionaries" : "dictionaries",
      error_name: err.name,
      error_code: "DICTIONARY_ERROR",
    });
    return json({ error: "Failed to resolve dictionaries" }, 502);
  }

  if (!validation.ok) {
    return json({
      status: "needs_clarification",
      question: validation.needs_clarification.question,
      parsed_request: parsed,
    });
  }

  const { request: spikeRequest, resolved } = validation;
  safeLog({
    stage: "resolved",
    departure_id: resolved.departure.id,
    country_id: resolved.country.id,
    meal_id: resolved.meal?.id ?? null,
  });

  const searchInput = {
    departure_id: resolved.departure.id,
    country_id: resolved.country.id,
    date_from: spikeRequest.date_from,
    date_to: spikeRequest.date_to,
    nights_from: spikeRequest.nights_from,
    nights_to: spikeRequest.nights_to,
    adults: spikeRequest.adults,
    children_ages: spikeRequest.children_ages,
    budget_max: spikeRequest.budget_max,
    meal_id: spikeRequest.meal_id ?? null,
    hotel_category: spikeRequest.hotel_category_min,
    hotel_rating: spikeRequest.hotel_rating_min,
    currency: "RUB",
    charter_only: true,
  };
  const effectivePriceTo = spikeRequest.budget_max != null && spikeRequest.budget_mode === "soft"
    ? Math.round(spikeRequest.budget_max * 1.1)
    : spikeRequest.budget_max;
  if (effectivePriceTo !== spikeRequest.budget_max) {
    searchInput.budget_max = effectivePriceTo;
  }
  const contractParams = {
    departureId: searchInput.departure_id,
    countryId: searchInput.country_id,
    dateFrom: searchInput.date_from,
    dateTo: searchInput.date_to,
    nightsFrom: searchInput.nights_from,
    nightsTo: searchInput.nights_to,
    adults: searchInput.adults,
    ...(searchInput.children_ages.length > 0 ? { childs: searchInput.children_ages } : {}),
    ...(searchInput.meal_id != null ? { meal: searchInput.meal_id } : {}),
    ...(searchInput.hotel_category != null ? { hotelCategory: searchInput.hotel_category } : {}),
    ...(searchInput.hotel_rating != null ? { hotelRating: searchInput.hotel_rating } : {}),
    ...(effectivePriceTo != null ? { priceTo: effectivePriceTo } : {}),
    currency: searchInput.currency,
    onlyCharter: searchInput.charter_only,
  };
  const contractValidation = TourvisorSearchParamsSchema.safeParse(contractParams);
  if (!contractValidation.success) {
    const field = String(contractValidation.error.issues[0]?.path[0] ?? "parameters");
    const questions: Record<string, string> = {
      departureId: "Уточните город вылета.",
      countryId: "Уточните страну назначения.",
      dateFrom: "Уточните даты поездки: диапазон вылета должен быть не больше 21 дня.",
      dateTo: "Уточните даты поездки в формате ГГГГ-ММ-ДД.",
      nightsFrom: "Уточните длительность поездки: диапазон ночей должен быть не больше 10.",
      nightsTo: "Уточните длительность поездки от 1 до 28 ночей.",
      adults: "Уточните количество взрослых туристов от 1 до 6.",
      childs: "Уточните возраст детей: допускается не более трёх детей до 18 лет.",
      meal: "Уточните желаемый тип питания.",
      hotelRating: "Уточните желаемый рейтинг отеля.",
      hotelCategory: "Уточните желаемую категорию отеля от 1 до 5 звёзд.",
      priceTo: "Уточните положительный максимальный бюджет поездки.",
      currency: "Уточните валюту бюджета.",
      onlyCharter: "Уточните допустимый тип перелёта.",
    };
    safeLog({ stage: "tour_search_validation", rejected_field: field });
    return json({
      status: "needs_clarification",
      question: questions[field] ?? "Уточните параметры поиска тура.",
      parsed_request: parsed,
    });
  }

  try {
    const { results, warnings } = await searchTours(
      searchInput,
      { jwt, fetchFn: config?.fetchFn, sleepFn: config?.sleepFn },
    );
    safeLog({ stage: "tour_results", candidate_count: results.length, warning_count: warnings.length });

    const spikeTours = tourCandidateToSpikeTour(results, resolved.country.id);
    const pipelineResult = runPipelineWithCandidates(spikeRequest, spikeTours);
    pipelineResult.warnings.push(...warnings);
    safeLog({ stage: "pipeline_result", ranked_count: pipelineResult.ranked_tours.length, warnings: pipelineResult.warnings.length });
    const offer = buildOffer(pipelineResult.ranked_tours);

    return json({
      status: "ready",
      parsed_request: parsed,
      resolved_request: {
        departure: resolved.departure,
        country: resolved.country,
        meal: resolved.meal,
        request: spikeRequest,
      },
      offer: {
        ranked_tours: pipelineResult.ranked_tours,
        agent_summary: offer.agent_summary,
        client_message: offer.client_message,
        warnings: pipelineResult.warnings,
      },
    });
  } catch (e) {
    if (e instanceof TourvisorError) {
      safeLog({
        stage: "tour_search",
        error_name: "TourvisorError",
        error_code: e.code,
        http_status: e.status,
      });
      return json({
        status: "error",
        error_code: "TOUR_SOURCE_ERROR",
        message: "Не удалось получить варианты туров.",
      }, 502);
    }
    safeLog({ stage: "pipeline", error_name: (e as Error).name, error_code: "UNKNOWN" });
    throw e;
  }
}

if (import.meta.main) {
  Deno.serve((req: Request) => handleTravelOfferTextRequest(req));
}
