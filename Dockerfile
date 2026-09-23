FROM denoland/deno:2.5.6
WORKDIR /app
ENV DENO_DIR=/deno-dir
COPY deno.json deno.lock ./
COPY supabase/functions/_shared/parser/ supabase/functions/_shared/parser/
COPY supabase/functions/_shared/schemas/ supabase/functions/_shared/schemas/
COPY supabase/functions/_shared/spike/ supabase/functions/_shared/spike/
COPY supabase/functions/_shared/tourvisor/ supabase/functions/_shared/tourvisor/
COPY supabase/functions/telegram-webhook/ supabase/functions/telegram-webhook/
COPY supabase/functions/travel-offer-text/ supabase/functions/travel-offer-text/
COPY container/ container/
RUN deno cache --frozen --config deno.json container/main.ts \
    && chown -R 1000:1000 /app /deno-dir
USER 1000:1000
EXPOSE 8080
CMD ["run", "--cached-only", "--frozen", "--config", "deno.json", "--allow-net", "--allow-env=PORT,TELEGRAM_BOT_TOKEN,TELEGRAM_WEBHOOK_SECRET,TELEGRAM_ALLOWED_USER_IDS,OPENROUTER_API_KEY,OPENROUTER_MODEL,TOURVISOR_JWT,INTERNAL_API_TOKEN", "container/main.ts"]
