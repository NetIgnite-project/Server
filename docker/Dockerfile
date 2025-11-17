FROM oven/bun:1 AS base

WORKDIR /opt/netignite/app

COPY . .
COPY ./config/config.sample.json /opt/netignite/config/config.sample.json

RUN bun install --production
RUN bun run build


FROM base AS production

WORKDIR /opt/netignite/

COPY --from=base /opt/netignite/app/.output ./app

VOLUME [ "/opt/netignite/data" ]
VOLUME [ "/opt/netignite/config" ]
VOLUME [ "/opt/netignite/logs" ]

EXPOSE 18232/tcp

ENV NITRO_ENV=production
ENV NITRO_HOST=0.0.0.0
ENV NITRO_PORT=18232

CMD [ "bun", "run", "./app/server/index.mjs" ]
