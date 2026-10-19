# Production image: the full-stack server bundle (.output/ — Nuxt + the Hono API, Bun preset) on
# the Bun runtime. Build it first (CI does this): `bun run build`. .output/ is self-contained;
# only the Drizzle migrations are copied next to it — DB.init applies them on startup
# (NETIGNITE_DB_AUTO_MIGRATE) from NETIGNITE_DB_MIGRATION_DIR. Layout: app under app/, data/
# and config/ are volumes beside it.
# Runtime config comes from the prefixed env: one `NETIGNITE_APP_URL` drives both the API side
# (CORS, links in emails) and the browser's config — the Nitro banner in nuxt.config.ts maps it
# onto `NUXT_PUBLIC_APP_URL` at server start; NUXT_PUBLIC_* remains a pure override.
FROM oven/bun:1-slim

RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /opt/netignite

COPY ./.output /opt/netignite/app/.output
COPY ./drizzle/migrations /opt/netignite/app/drizzle/migrations

EXPOSE 18232/tcp

ENV NODE_ENV=production

ENV NITRO_HOST=::
ENV NITRO_PORT=18232

ENV NETIGNITE_DB_PATH=/opt/netignite/data/netignite.sqlite
ENV NETIGNITE_DB_AUTO_MIGRATE=true
ENV NETIGNITE_DB_MIGRATION_DIR=/opt/netignite/app/drizzle/migrations

ENV NETIGNITE_LOG_DIR=/opt/netignite/data/logs
ENV NETIGNITE_CONFIG_BASE_DIR=/opt/netignite/config


VOLUME /opt/netignite/data
VOLUME /opt/netignite/config

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
	CMD curl -f http://localhost:18232/api/health || exit 1

CMD ["bun", "run", "/opt/netignite/app/.output/server/index.mjs"]
