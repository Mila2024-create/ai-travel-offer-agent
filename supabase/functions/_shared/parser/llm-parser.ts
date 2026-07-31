export type ParsedRequest = {
  departure: string;
  country: string;
  date_from: string;
  date_to: string;
  nights_from: number;
  nights_to: number;
  adults: number;
  children_ages: number[];
  budget: number | null;
  budget_mode: "hard" | "soft" | "unknown" | "not_specified";
  meal: string | null;
  hotel_category_min: number | null;
  hotel_rating_min: number | null;
};

const PARSER_SCHEMA = {
  type: "object",
  properties: {
    departure: {
      type: "string",
      description: "Город вылета (название города, например Москва, Санкт-Петербург, Казань)",
    },
    country: {
      type: "string",
      description: "Страна назначения (название страны, например Турция, Египет, ОАЭ)",
    },
    date_from: {
      type: "string",
      description: "Начало диапазона дат вылета в формате YYYY-MM-DD",
    },
    date_to: {
      type: "string",
      description: "Конец диапазона дат вылета в формате YYYY-MM-DD",
    },
    nights_from: {
      type: "number",
      description: "Минимальное количество ночей",
    },
    nights_to: {
      type: "number",
      description: "Максимальное количество ночей",
    },
    adults: {
      type: "number",
      description: "Количество взрослых",
    },
    children_ages: {
      type: "array",
      description: "Возраст детей (пустой массив если детей нет)",
      items: { type: "number" },
    },
    budget: {
      anyOf: [
        { type: "number", description: "Максимальный бюджет в рублях" },
        { type: "null" },
      ],
      description: "Максимальный бюджет в рублях. null если бюджет не указан.",
    },
    budget_mode: {
      type: "string",
      enum: ["hard", "soft", "unknown", "not_specified"],
      description: "Режим бюджета: hard — строгий лимит, soft — с запасом, unknown — бюджет не знаю / покажи рынок, not_specified — бюджет не упомянут",
    },
    meal: {
      anyOf: [
        { type: "string", description: "Тип питания (AI, HB, BB, FB и т.д.)" },
        { type: "null" },
      ],
      description: "Предпочтительный тип питания. null если не указано.",
    },
    hotel_category_min: {
      anyOf: [
        { type: "number", description: "Минимальное количество звёзд отеля (1-5)" },
        { type: "null" },
      ],
      description: "Минимальная категория отеля. null если не указано.",
    },
    hotel_rating_min: {
      anyOf: [
        { type: "number", description: "Минимальный рейтинг отеля (0-5)" },
        { type: "null" },
      ],
      description: "Минимальный рейтинг отеля. null если не указано.",
    },
  },
  required: [
    "departure", "country", "date_from", "date_to",
    "nights_from", "nights_to", "adults", "children_ages",
    "budget", "budget_mode", "meal",
    "hotel_category_min", "hotel_rating_min",
  ],
  additionalProperties: false,
};

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

function getConfig(): { apiKey: string; model: string } {
  const apiKey = Deno.env.get("OPENROUTER_API_KEY");
  const model = Deno.env.get("OPENROUTER_MODEL");
  if (!apiKey) throw new ParserConfigError("OPENROUTER_API_KEY");
  if (!model) throw new ParserConfigError("OPENROUTER_MODEL");
  return { apiKey, model };
}

export class ParserConfigError extends Error {
  constructor(missingVar: string) {
    super(`Server configuration error: ${missingVar} is not set`);
    this.name = "ParserConfigError";
  }
}

const SYSTEM_PROMPT = `Ты — помощник для поиска туров. Извлеки параметры запроса на тур из текста пользователя.

Правила:
1. Даты указывай строго в формате YYYY-MM-DD. Если указан месяц без числа — используй 1-е число для date_from и последнее число месяца для date_to.
2. Если пользователь не указал конкретную дату, а сказал "в июне" или "летом" — используй разумные границы сезона.
3. Количество ночей: если не указано, поставь 1 для nights_from и 14 для nights_to.
4. Количество взрослых: по умолчанию 2.
5. Дети: если не указаны — пустой массив.
6. Если пользователь не указал бюджет, budget_mode должен быть "not_specified", а budget — null.
7. Если пользователь явно сказал что бюджет не важен / не знает / покажи рынок — budget_mode="unknown", budget=null.
8. Если бюджет указан как примерный ориентир — budget_mode="soft".
9. Если бюджет указан как строгий лимит — budget_mode="hard".
10. Названия городов, стран и типов питания пиши по-русски.
11. Отель: если не указаны звёзды или рейтинг — ставь null.
12. Не выдумывай значения, которых нет в тексте.`;

export async function parseText(text: string, fetchFn?: typeof fetch): Promise<ParsedRequest> {
  const { apiKey, model } = getConfig();
  const doFetch = fetchFn ?? fetch;

  const body = {
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: text },
    ],
    response_format: {
      type: "json_schema" as const,
      json_schema: {
        name: "travel_offer_parser",
        strict: true,
        schema: PARSER_SCHEMA,
      },
    },
    provider: {
      require_parameters: true,
    },
    temperature: 0.1,
    max_tokens: 1024,
  };

  let res: Response;
  try {
    res = await doFetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
        "X-Title": "travel-offer-agent",
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("OpenRouter request failed");
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => "unknown");
    throw new Error(`OpenRouter returned HTTP ${res.status}: ${errText.slice(0, 200)}`);
  }

  const json = await res.json() as Record<string, unknown>;
  const choices = json.choices as Array<Record<string, unknown>> | undefined;
  if (!choices || choices.length === 0) {
    throw new Error("OpenRouter returned no choices");
  }
  const message = choices[0].message as Record<string, unknown> | undefined;
  const content = message?.content as string | undefined;
  if (!content) {
    throw new Error("OpenRouter response has no content");
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content) as Record<string, unknown>;
  } catch {
    throw new Error("OpenRouter returned invalid JSON");
  }

  return {
    departure: String(parsed.departure ?? ""),
    country: String(parsed.country ?? ""),
    date_from: String(parsed.date_from ?? ""),
    date_to: String(parsed.date_to ?? ""),
    nights_from: Number(parsed.nights_from ?? 1),
    nights_to: Number(parsed.nights_to ?? 14),
    adults: Number(parsed.adults ?? 2),
    children_ages: Array.isArray(parsed.children_ages) ? parsed.children_ages.map(Number) : [],
    budget: parsed.budget != null ? Number(parsed.budget) : null,
    budget_mode: (parsed.budget_mode as ParsedRequest["budget_mode"]) ?? "not_specified",
    meal: parsed.meal != null ? String(parsed.meal) : null,
    hotel_category_min: parsed.hotel_category_min != null ? Number(parsed.hotel_category_min) : null,
    hotel_rating_min: parsed.hotel_rating_min != null ? Number(parsed.hotel_rating_min) : null,
  };
}