FROM oven/bun:1.3.14-alpine AS deps

WORKDIR /app

COPY package.json bun.lock bunfig.toml ./
COPY backend/package.json backend/package.json
COPY farlands-app/package.json farlands-app/package.json
COPY packages/db/package.json packages/db/package.json

RUN bun install --frozen-lockfile

FROM oven/bun:1.3.14-alpine AS runner

RUN apk upgrade --no-cache

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3001

COPY package.json bun.lock bunfig.toml ./
COPY backend ./backend
COPY packages ./packages
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/backend/node_modules ./backend/node_modules
COPY --from=deps /app/packages/db/node_modules ./packages/db/node_modules

WORKDIR /app/backend

USER bun
EXPOSE 3001

CMD ["bun", "run", "src/index.ts"]
