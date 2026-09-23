declare global {
  var EdgeRuntime: { waitUntil: (promise: Promise<unknown>) => void } | undefined;
}

export type WebhookConfig = {
  telegramBotToken?: string;
  webhookSecret?: string;
  allowedUserIds?: string;
  internalApiToken?: string;
  backendUrl?: string;
  fetchFn?: typeof fetch;
  backendHandler?: (request: Request) => Promise<Response>;
  executionMode?: "request" | "edge";
};

const TELEGRAM_API_BASE = "https://api.telegram.org";
const SPLIT_MAX_LEN = 3900;
const CLARIFICATION_MARKER = "Исходный запрос:";
const MAX_BODY_BYTES = 64 * 1024;

function json(data: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function splitMessage(text: string, maxLen = SPLIT_MAX_LEN): string[] {
  if (text.length <= maxLen) return [text];
  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      parts.push(remaining);
      break;
    }
    const slice = remaining.slice(0, maxLen);
    const lastParagraph = slice.lastIndexOf("\n\n");
    const lastNewline = slice.lastIndexOf("\n");
    const breakAt = lastParagraph > 0 ? lastParagraph + 2
      : lastNewline > 0 ? lastNewline + 1
      : maxLen;
    parts.push(remaining.slice(0, breakAt).trimEnd());
    remaining = remaining.slice(breakAt).trimStart();
  }
  return parts;
}

async function sendTelegramMessage(
  chatId: number,
  text: string,
  config: WebhookConfig,
  replyMarkup?: Record<string, unknown>,
): Promise<void> {
  const token = config.telegramBotToken ?? Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
  const fetchFn = config.fetchFn ?? fetch;
  const body: Record<string, unknown> = { chat_id: chatId, text };
  if (replyMarkup) body.reply_markup = replyMarkup;
  try {
    const res = await fetchFn(`${TELEGRAM_API_BASE}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.error(JSON.stringify({ stage: "telegram_api", status: res.status }));
    }
  } catch {
    console.error(JSON.stringify({ stage: "telegram_api", error: "SEND_FAILED" }));
  }
}

async function callBackend(
  text: string,
  config: WebhookConfig,
): Promise<Record<string, unknown>> {
  const backendUrl = config.backendHandler ? "http://internal/travel-offer-text" : config.backendUrl ??
    (Deno.env.get("SUPABASE_URL")
      ? `${Deno.env.get("SUPABASE_URL")}/functions/v1/travel-offer-text`
      : "");
  if (!backendUrl) {
    console.error(JSON.stringify({ stage: "backend", error: "SUPABASE_URL not configured" }));
    return { status: "error", message: "Ошибка обработки запроса." };
  }
  const internalToken = config.internalApiToken ?? Deno.env.get("INTERNAL_API_TOKEN") ?? "";
  const fetchFn = config.fetchFn ?? fetch;
  const init: RequestInit = {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Internal-Token": internalToken,
    },
    body: JSON.stringify({ text }),
  };
  const res = config.backendHandler
    ? await config.backendHandler(new Request(backendUrl, init))
    : await fetchFn(backendUrl, init);
  if (!res.ok) {
    console.error(JSON.stringify({ stage: "backend", status: res.status }));
    return { status: "error", message: "Ошибка обработки запроса." };
  }
  return await res.json() as Record<string, unknown>;
}

export async function processTelegramUpdate(
  update: Record<string, unknown>,
  config: WebhookConfig,
): Promise<void> {
  const message = update.message as Record<string, unknown> | undefined;
  if (!message || typeof message.text !== "string") return;
  if ((message.chat as Record<string, unknown>)?.type !== "private") return;

  const chatId = (message.chat as Record<string, unknown>)?.id as number;
  const text = message.text as string;
  const userId = (message.from as Record<string, unknown>)?.id as number;

  const allowedRaw = config.allowedUserIds ?? Deno.env.get("TELEGRAM_ALLOWED_USER_IDS") ?? "";
  const allowedIds = allowedRaw.split(",").map((s) => parseInt(s.trim(), 10)).filter(Number.isFinite);
  if (!allowedIds.includes(userId)) return;

  if (text.startsWith("/start")) {
    await sendTelegramMessage(chatId, "Добро пожаловать! Отправьте мне описание желаемого тура, и я подберу лучшие варианты.", config);
    return;
  }
  if (text.startsWith("/help")) {
    await sendTelegramMessage(chatId, "Отправьте описание желаемого тура, например: «Хочу в Турцию на двоих на неделю в августе».", config);
    return;
  }

  const replyTo = message.reply_to_message as Record<string, unknown> | undefined;
  if (replyTo?.text && typeof replyTo.text === "string") {
    const replyText = replyTo.text as string;
    const markerIndex = replyText.lastIndexOf(CLARIFICATION_MARKER);
    if (markerIndex !== -1) {
      const originalQuery = replyText.slice(markerIndex + CLARIFICATION_MARKER.length).trim();
      const combined = `${originalQuery} ${text}`;
      await processBackendResponse(chatId, combined, config);
      return;
    }
  }

  await processBackendResponse(chatId, text, config);
}

async function processBackendResponse(
  chatId: number,
  text: string,
  config: WebhookConfig,
): Promise<void> {
  let backendResponse: Record<string, unknown>;
  try {
    backendResponse = await callBackend(text, config);
  } catch {
    console.error(JSON.stringify({ stage: "backend", error: "BACKEND_FAILED" }));
    await sendTelegramMessage(chatId, "Ошибка обработки запроса.", config);
    return;
  }

  if (backendResponse.status === "ready") {
    const offer = backendResponse.offer as Record<string, unknown> ?? {};
    const agentSummary = offer.agent_summary as string ?? "";
    const clientMessage = offer.client_message as string ?? "";
    if (agentSummary) {
      const parts = splitMessage(agentSummary);
      for (const part of parts) {
        await sendTelegramMessage(chatId, part, config);
      }
    }
    if (clientMessage) {
      const parts = splitMessage(clientMessage);
      for (const part of parts) {
        await sendTelegramMessage(chatId, part, config);
      }
    }
    return;
  }

  if (backendResponse.status === "needs_clarification") {
    const question = backendResponse.question as string ?? "";
    const messageText = `${question}\n\n${CLARIFICATION_MARKER} ${text}`;
    await sendTelegramMessage(chatId, messageText, config, {
      force_reply: true,
      selective: true,
    });
    return;
  }

  const errorMessage = backendResponse.message as string ?? "Произошла ошибка. Попробуйте позже.";
  await sendTelegramMessage(chatId, errorMessage, config);
}

export async function handleTelegramWebhook(
  request: Request,
  config?: WebhookConfig,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { Allow: "POST" } });
  }
  const expectedSecret = config?.webhookSecret ?? Deno.env.get("TELEGRAM_WEBHOOK_SECRET") ?? "";
  const providedSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
  if (!expectedSecret || providedSecret !== expectedSecret) {
    return json({ error: "Unauthorized" }, 401);
  }

  let update: Record<string, unknown>;
  try {
    const reader = request.body?.getReader();
    if (!reader) return json({ error: "Invalid request body" }, 400);
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BODY_BYTES) {
          await reader.cancel();
          return json({ error: "Request body too large" }, 413);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return json({ error: "Invalid request body" }, 400);
    }
    update = parsed as Record<string, unknown>;
  } catch {
    return json({ error: "Invalid request body" }, 400);
  }

  const resolvedConfig: WebhookConfig = {
    telegramBotToken: config?.telegramBotToken ?? Deno.env.get("TELEGRAM_BOT_TOKEN"),
    webhookSecret: config?.webhookSecret ?? Deno.env.get("TELEGRAM_WEBHOOK_SECRET"),
    allowedUserIds: config?.allowedUserIds ?? Deno.env.get("TELEGRAM_ALLOWED_USER_IDS"),
    internalApiToken: config?.internalApiToken ?? Deno.env.get("INTERNAL_API_TOKEN"),
    backendUrl: config?.backendUrl,
    fetchFn: config?.fetchFn ?? fetch,
    backendHandler: config?.backendHandler,
  };

  const run = (): Promise<void> => processTelegramUpdate(update, resolvedConfig);
  if (config?.executionMode !== "request" && globalThis.EdgeRuntime?.waitUntil) {
    globalThis.EdgeRuntime.waitUntil(run());
  } else {
    await run();
  }

  return json({ ok: true });
}

if (import.meta.main) {
  Deno.serve((req: Request) => handleTelegramWebhook(req));
}
