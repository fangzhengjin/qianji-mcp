FROM oven/bun:1.3.14-slim AS verify

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY src ./src
COPY test ./test
COPY tsconfig.json ./tsconfig.json

RUN bun run typecheck && bun test

FROM oven/bun:1.3.14-slim

LABEL org.opencontainers.image.source="https://github.com/fangzhengjin/qianji-mcp" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app

ENV QIANJI_MCP_HOST=0.0.0.0 \
    QIANJI_MCP_DATABASE_PATH=/data/qianji.db

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY --from=verify --chown=bun:bun /app/src ./src
COPY --chown=bun:bun LICENSE ./LICENSE

RUN mkdir -p /data && chown bun:bun /data

USER bun

EXPOSE 3000

CMD ["bun", "src/http-server.ts"]
