# EmDash site on Node 22 — Astro standalone server.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
WORKDIR /app
COPY . .
ENV NODE_ENV=production
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4321
# SQLite CLI for the `backup` service in docker-compose.yml, which reuses this image with a
# different command. Baked in at build time on purpose: installing it at container start costs
# minutes on a slow link and crash-loops under `restart: always` when `apk` cannot reach the network.
RUN apk add --no-cache sqlite
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/seed ./seed
COPY --from=build /app/public ./public
# Not taken from the build stage: only the backup container reads this.
COPY backup ./backup
EXPOSE 4321
# CMD, not ENTRYPOINT, so the backup service can replace it with `command:`.
CMD ["node", "./dist/server/entry.mjs"]
