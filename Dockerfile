# Build stage: compile TypeScript and install production dependencies.
FROM node:22-bookworm-slim AS build
WORKDIR /app
# Toolchain in case better-sqlite3 has no prebuilt binary for this platform.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json astro.config.mjs ./
COPY src ./src
COPY web ./web
COPY public ./public
# Compiles the bot (dist/) and the Astro web pages (web-dist/).
RUN ASTRO_TELEMETRY_DISABLED=1 npm run build && npm prune --omit=dev

# Runtime stage.
FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/web-dist ./web-dist
RUN mkdir -p /data && chown node:node /data && command -v setpriv
EXPOSE 3000
# Fly.io mounts the volume owned by root, so fix ownership of /data at start,
# then drop to the unprivileged "node" user. exec keeps Node as PID 1 for clean shutdowns.
CMD ["sh", "-c", "chown node:node /data && exec setpriv --reuid=node --regid=node --init-groups node dist/index.js"]
