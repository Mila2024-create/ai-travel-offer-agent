import { TOURVISOR_BASE_URL, TourvisorError } from "./client.ts";

export type DictionaryItem = { id: number; name: string };

export type ResolvedDeparture = { id: number; name: string; matchedName: string };
export type ResolvedCountry = { id: number; name: string; matchedName: string };
export type ResolvedMeal = { id: number; name: string; matchedName: string };

function buildUrl(base: string, path: string, query?: URLSearchParams): string {
  const qs = query?.toString();
  return qs ? `${base}${path}?${qs}` : `${base}${path}`;
}

function defaultFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return fetch(input, init);
}

async function tvFetch(
  url: string,
  jwt: string,
  fetchFn: typeof fetch,
  stage: string,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchFn(url, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
  } catch {
    throw new TourvisorError(
      "Dictionary upstream request failed",
      "UPSTREAM_FETCH_FAILED",
      undefined,
      stage,
    );
  }
  if (!res.ok) {
    throw new TourvisorError(
      `Dictionary API returned HTTP ${res.status}`,
      "HTTP_ERROR",
      res.status,
      stage,
    );
  }
  try {
    return await res.json();
  } catch {
    throw new TourvisorError(
      "Dictionary response is not valid JSON",
      "INVALID_DICTIONARY_RESPONSE",
      undefined,
      stage,
    );
  }
}

async function fetchItems(
  path: string,
  jwt: string,
  fetchFn: typeof fetch,
  query?: URLSearchParams,
): Promise<DictionaryItem[]> {
  const baseUrl = TOURVISOR_BASE_URL;
  const url = buildUrl(baseUrl, path, query);
  const stage = path.replace("/", "");
  const body = await tvFetch(url, jwt, fetchFn, stage);
  const isArray = Array.isArray(body);
  const count = isArray ? (body as unknown[]).length : 0;
  const logEntry: Record<string, unknown> = {
    stage,
    response_type: isArray ? "array" : typeof body,
    item_count: count,
  };
  if (path === "/countries" && query) {
    logEntry.departure_id = query.get("departureId");
    logEntry.pathname = path;
    logEntry.query_string = query.toString();
  }
  console.error(JSON.stringify(logEntry));
  if (!isArray) {
    throw new TourvisorError(
      "Dictionary response is not an array",
      "INVALID_DICTIONARY_RESPONSE",
      undefined,
      stage,
    );
  }
  const items: DictionaryItem[] = [];
  for (const raw of body) {
    const r = raw as Record<string, unknown>;
    const id = typeof r.id === "number" ? r.id : Number(r.id);
    const name = typeof r.name === "string" ? r.name.trim() : "";
    if (Number.isFinite(id) && name) {
      items.push({ id, name });
    }
  }
  return items;
}

export async function fetchDepartures(
  jwt: string,
  fetchFn?: typeof fetch,
): Promise<DictionaryItem[]> {
  return fetchItems("/departures", jwt, fetchFn ?? defaultFetch);
}

export async function fetchCountries(
  departureId: number,
  jwt: string,
  fetchFn?: typeof fetch,
): Promise<DictionaryItem[]> {
  return fetchItems(
    "/countries",
    jwt,
    fetchFn ?? defaultFetch,
    new URLSearchParams({ departureId: String(departureId) }),
  );
}

export async function fetchMeals(
  jwt: string,
  fetchFn?: typeof fetch,
): Promise<DictionaryItem[]> {
  return fetchItems("/meals", jwt, fetchFn ?? defaultFetch);
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[^a-zа-яё0-9\s-]/g, "")
    .trim();
}

const DEPARTURE_ALIASES: Record<string, string[]> = {
  "москва": ["moscow", "moskva"],
  "санкт-петербург": ["spb", "питер", "saint petersburg", "st petersburg", "sankt-peterburg"],
  "казань": ["kazan"],
  "екатеринбург": ["ekaterinburg", "yekaterinburg"],
  "новосибирск": ["novosibirsk"],
  "краснодар": ["krasnodar"],
  "сочи": ["sochi", "adler"],
  "ростов-на-дону": ["rostov-on-don", "rostov na donu", "ростов"],
  "самара": ["samara"],
  "уфа": ["ufa"],
  "пермь": ["perm"],
  "владивосток": ["vladivostok"],
};

const COUNTRY_ALIASES: Record<string, string[]> = {
  "турция": ["turkey", "türkiye", "turkiye"],
  "египет": ["egypt"],
  "оаэ": [
    "uae",
    "объединенные арабские эмираты",
    "объединённые арабские эмираты",
    "эмираты",
    "dubai",
    "дубай",
  ],
  "таиланд": ["thailand", "тайланд"],
  "россия": ["russia"],
  "абхазия": ["abkhazia"],
  "куба": ["cuba"],
  "мальдивы": ["maldives", "мальдивские острова"],
  "греция": ["greece"],
  "кипр": ["cyprus"],
  "испания": ["spain"],
  "италия": ["italy"],
  "франция": ["france"],
  "черногория": ["montenegro"],
  "вьетнам": ["vietnam"],
  "индия": ["india", "goa", "гоа"],
  "шри-ланка": ["sri lanka", "шри ланка"],
  "доминикана": ["dominican republic", "доминиканская республика"],
  "мексика": ["mexico"],
  "израиль": ["israel"],
  "грузия": ["georgia"],
  "азербайджан": ["azerbaijan"],
  "армения": ["armenia"],
  "узбекистан": ["uzbekistan"],
  "китай": ["china", "хайнань", "hainan"],
};

const MEAL_ALIASES: Record<string, string[]> = {
  "ai": [
    "all inclusive",
    "всё включено",
    "все включено",
    "ультра всё включено",
    "ultra all inclusive",
    "uai",
  ],
  "hb": ["half board", "полупансион", "завтрак и ужин", "halfboard"],
  "bb": ["bed & breakfast", "bed and breakfast", "завтрак", "breakfast"],
  "fb": ["full board", "fullboard", "полный пансион", "завтрак обед и ужин"],
  "ob": ["room only", "без питания", "only breakfast", "no meals"],
  "hb+": ["hb plus", "half board plus", "полупансион плюс"],
  "fb+": ["fb plus", "full board plus", "полный пансион плюс"],
};

function findMatch(
  rawInput: string,
  items: DictionaryItem[],
  aliases: Record<string, string[]>,
): { id: number; name: string; matchedName: string } | null {
  const input = normalize(rawInput);
  if (!input) return null;

  for (const item of items) {
    const itemName = normalize(item.name);
    if (itemName === input) {
      return { id: item.id, name: item.name, matchedName: item.name };
    }
  }

  for (const [canonicalNormalized, aliasList] of Object.entries(aliases)) {
    if (canonicalNormalized === input || aliasList.some((a) => normalize(a) === input)) {
      for (const item of items) {
        if (normalize(item.name) === canonicalNormalized) {
          return { id: item.id, name: item.name, matchedName: canonicalNormalized };
        }
      }
      for (const item of items) {
        if (aliasList.some((a) => normalize(item.name) === normalize(a))) {
          return { id: item.id, name: item.name, matchedName: item.name };
        }
      }
      const partialAliasMatches = items.filter((item) =>
        aliasList.some((a) =>
          normalize(item.name).includes(normalize(a)) ||
          normalize(a).includes(normalize(item.name))
        )
      );
      if (partialAliasMatches.length === 1) {
        const item = partialAliasMatches[0];
        return { id: item.id, name: item.name, matchedName: item.name };
      }
      if (partialAliasMatches.length > 1) {
        return null;
      }
    }
  }

  const partialMatches = items.filter((item) => {
    const itemName = normalize(item.name);
    return itemName.includes(input) || input.includes(itemName);
  });
  if (partialMatches.length === 1) {
    const item = partialMatches[0];
    return { id: item.id, name: item.name, matchedName: item.name };
  }

  return null;
}

export class DictionaryResolver {
  #jwt: string;
  #fetchFn: typeof fetch;
  #departuresCache: DictionaryItem[] | null = null;
  #countriesCache: Map<number, DictionaryItem[]> = new Map();
  #mealsCache: DictionaryItem[] | null = null;

  constructor(jwt: string, fetchFn?: typeof fetch) {
    this.#jwt = jwt;
    this.#fetchFn = fetchFn ?? defaultFetch;
  }

  async resolveDeparture(rawInput: string): Promise<ResolvedDeparture | null> {
    if (!this.#departuresCache) {
      this.#departuresCache = await fetchDepartures(this.#jwt, this.#fetchFn);
    }
    const result = findMatch(rawInput, this.#departuresCache, DEPARTURE_ALIASES);
    return result;
  }

  async resolveCountry(departureId: number, rawInput: string): Promise<ResolvedCountry | null> {
    if (!this.#countriesCache.has(departureId)) {
      const countries = await fetchCountries(departureId, this.#jwt, this.#fetchFn);
      this.#countriesCache.set(departureId, countries);
    }
    const countries = this.#countriesCache.get(departureId)!;
    const result = findMatch(rawInput, countries, COUNTRY_ALIASES);
    return result;
  }

  async resolveMeal(rawInput: string): Promise<ResolvedMeal | null> {
    if (!this.#mealsCache) {
      this.#mealsCache = await fetchMeals(this.#jwt, this.#fetchFn);
    }
    const result = findMatch(rawInput, this.#mealsCache, MEAL_ALIASES);
    return result;
  }
}
