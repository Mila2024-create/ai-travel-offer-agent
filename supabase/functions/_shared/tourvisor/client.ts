export const TOURVISOR_BASE_URL = "https://api.tourvisor.ru/search/api/v1";

export class TourvisorError extends Error {
  code: string;
  status: number | undefined;
  stage: string | undefined;

  constructor(message: string, code: string, status?: number, stage?: string) {
    super(message);
    this.name = "TourvisorError";
    this.code = code;
    this.status = status;
    this.stage = stage;
  }
}

export type TourvisorSearchInput = {
  departure_id: number;
  country_id: number;
  date_from: string;
  date_to: string;
  nights_from: number;
  nights_to: number;
  adults: number;
  children_ages?: number[];
  budget_max?: number | null;
  meal_id?: number | null;
  hotel_category?: number | null;
  hotel_rating?: number | null;
  currency: string;
  charter_only: boolean;
};

export type TourvisorSearchStatus = {
  searchId: number;
  status: string;
  progress: number;
  minPrice?: number;
  timePassed?: number;
};

export type TourCandidate = {
  hotel_id: number;
  hotel_name: string;
  country: string | null;
  resort: string | null;
  hotel_category: number | null;
  hotel_rating: number | null;
  tour_id: string;
  departure_date: string | null;
  nights: number | null;
  meal: string | null;
  room: string | null;
  tour_operator: string | null;
  price: number;
  currency: string | null;
  hotel_availability: string | null;
  flight_availability: string | null;
};

export type TourvisorClientOptions = {
  jwt: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
  sleepFn?: (ms: number) => Promise<void>;
  timeoutMs?: number;
};

export function buildTourvisorParams(input: TourvisorSearchInput): URLSearchParams {
  const params = new URLSearchParams();

  params.set("departureId", String(input.departure_id));
  params.set("countryId", String(input.country_id));
  params.set("dateFrom", input.date_from);
  params.set("dateTo", input.date_to);
  params.set("nightsFrom", String(input.nights_from));
  params.set("nightsTo", String(input.nights_to));
  params.set("adults", String(input.adults));
  params.set("currency", input.currency);
  params.set("onlyCharter", String(input.charter_only));

  if (input.children_ages != null && input.children_ages.length > 0) {
    for (const age of input.children_ages) {
      params.append("childs", String(age));
    }
  }

  if (input.meal_id != null) {
    params.set("meal", String(input.meal_id));
  }

  if (input.hotel_category != null) {
    params.set("hotelCategory", String(input.hotel_category));
  }

  if (input.hotel_rating != null) {
    params.set("hotelRating", String(input.hotel_rating));
  }

  if (input.budget_max != null) {
    params.set("priceTo", String(input.budget_max));
  }

  return params;
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

function defaultFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return fetch(input, init);
}

function buildUrl(base: string, path: string, query?: URLSearchParams): string {
  const qs = query?.toString();
  return qs ? `${base}${path}?${qs}` : `${base}${path}`;
}

async function tvFetch(
  url: string,
  jwt: string,
  fetchFn: typeof fetch,
  signal?: AbortSignal,
): Promise<Response> {
  let res: Response;
  try {
    res = await fetchFn(url, {
      headers: {
        Authorization: `Bearer ${jwt}`,
      },
      signal,
    });
  } catch {
    throw new TourvisorError(
      "Tourvisor upstream request failed",
      "UPSTREAM_FETCH_FAILED",
    );
  }

  if (!res.ok) {
    if (res.status === 400) {
      const body = await res.clone().json().catch(() => null);
      const safeError: Record<string, unknown> = {
        stage: "tour_search",
        http_status: res.status,
      };
      if (body && typeof body === "object" && !Array.isArray(body)) {
        const record = body as Record<string, unknown>;
        for (const field of ["code", "error", "message", "detail", "details"]) {
          if (field in record) safeError[field] = record[field];
        }
      }
      console.error(JSON.stringify(safeError));
    }
    const safeMessage = `Tourvisor API returned HTTP ${res.status}`;
    throw new TourvisorError(safeMessage, "HTTP_ERROR", res.status);
  }
  return res;
}

export async function startSearch(
  input: TourvisorSearchInput,
  options: TourvisorClientOptions & { signal?: AbortSignal },
): Promise<number> {
  const baseUrl = options.baseUrl ?? TOURVISOR_BASE_URL;
  const fetchFn = options.fetchFn ?? defaultFetch;
  const params = buildTourvisorParams(input);
  const url = buildUrl(baseUrl, "/tours/search", params);
  console.error(JSON.stringify({
    stage: "start_search",
    query_string: params.toString(),
  }));

  const res = await tvFetch(url, options.jwt, fetchFn, options.signal);
  const body = await res.json() as Record<string, unknown>;

  if (typeof body.searchId !== "number") {
    throw new TourvisorError("Invalid search response: missing searchId", "INVALID_RESPONSE");
  }

  return body.searchId;
}

export async function getSearchStatus(
  searchId: number,
  options: TourvisorClientOptions & { signal?: AbortSignal },
): Promise<TourvisorSearchStatus> {
  const baseUrl = options.baseUrl ?? TOURVISOR_BASE_URL;
  const fetchFn = options.fetchFn ?? defaultFetch;
  const statusPath = `/tours/search/${searchId}/status`;
  const statusQuery = new URLSearchParams({ operatorStatus: "false" });
  const url = buildUrl(baseUrl, statusPath, statusQuery);

  const res = await tvFetch(url, options.jwt, fetchFn, options.signal);
  const body = await res.json() as Record<string, unknown>;

  return {
    searchId: typeof body.searchId === "number" ? body.searchId : 0,
    status: typeof body.status === "string" ? body.status : "",
    progress: typeof body.progress === "number" ? body.progress : 0,
    minPrice: typeof body.minPrice === "number" ? body.minPrice : undefined,
    timePassed: typeof body.timePassed === "number" ? body.timePassed : undefined,
  };
}

export async function getSearchResults(
  searchId: number,
  options: TourvisorClientOptions & { signal?: AbortSignal },
): Promise<unknown[]> {
  const baseUrl = options.baseUrl ?? TOURVISOR_BASE_URL;
  const fetchFn = options.fetchFn ?? defaultFetch;
  const resultPath = `/tours/search/${searchId}`;
  const resultQuery = new URLSearchParams({ limit: "25" });
  const url = buildUrl(baseUrl, resultPath, resultQuery);

  const res = await tvFetch(url, options.jwt, fetchFn, options.signal);
  const body = await res.json();

  if (!Array.isArray(body)) {
    throw new TourvisorError(
      "Invalid results response: body is not an array",
      "INVALID_RESULTS_RESPONSE",
    );
  }
  return body;
}

export async function searchTours(
  input: TourvisorSearchInput,
  options: TourvisorClientOptions & { signal?: AbortSignal },
): Promise<{ results: TourCandidate[]; warnings: string[] }> {
  const sleepFn = options.sleepFn ?? defaultSleep;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const pollInterval = 3_000;
  const startTime = Date.now();

  const searchId = await startSearch(input, options);

  await sleepFn(pollInterval);

  const warnings: string[] = [];

  while (true) {
    const elapsed = Date.now() - startTime;

    if (elapsed >= timeoutMs) {
      const raw = await getSearchResults(searchId, options);
      const candidates = mapTourvisorResults(raw);
      if (candidates.length > 0) {
        warnings.push("Search timed out, using partial results");
        return { results: candidates, warnings };
      }
      throw new TourvisorError("Search timed out with no results", "SEARCH_TIMEOUT");
    }

    const status = await getSearchStatus(searchId, options);

    if (status.progress >= 100) {
      const raw = await getSearchResults(searchId, options);
      return { results: mapTourvisorResults(raw), warnings };
    }

    await sleepFn(pollInterval);
  }
}

export function mapTourvisorResults(raw: unknown): TourCandidate[] {
  if (!Array.isArray(raw)) return [];

  const candidates: TourCandidate[] = [];

  for (const hotel of raw) {
    if (!hotel || typeof hotel !== "object") continue;

    const h = hotel as Record<string, unknown>;
    const hotelId = h.id as number | undefined;
    const hotelName = h.name as string | undefined;

    if (hotelId == null || !hotelName) continue;

    const countryObj = h.country as Record<string, unknown> | undefined;
    const regionObj = h.region as Record<string, unknown> | undefined;
    const subRegionObj = h.subRegion as Record<string, unknown> | undefined;

    const tours = h.tours as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(tours)) continue;

    for (const tour of tours) {
      if (!tour || typeof tour !== "object") continue;

      const t = tour as Record<string, unknown>;
      const tourId = t.id as string | undefined;
      const price = t.price as number | undefined;

      if (tourId == null || price == null || price <= 0) continue;

      const mealObj = t.meal as Record<string, unknown> | undefined;
      const opObj = t.operator as Record<string, unknown> | undefined;

      const resort = (subRegionObj?.name as string) ||
        (regionObj?.name as string) ||
        null;

      candidates.push({
        hotel_id: hotelId,
        hotel_name: hotelName,
        country: (countryObj?.name as string) ?? null,
        resort,
        hotel_category: (h.category as number) ?? null,
        hotel_rating: (h.rating as number) ?? null,
        tour_id: tourId,
        departure_date: (t.date as string) ?? null,
        nights: (t.nights as number) ?? null,
        meal: (mealObj?.name as string) ?? null,
        room: (t.roomType as string) ?? null,
        tour_operator: (opObj?.name as string) ?? null,
        price: price,
        currency: (t.currency as string) ?? (h.currency as string) ?? null,
        hotel_availability: null,
        flight_availability: null,
      });
    }
  }

  return candidates;
}
