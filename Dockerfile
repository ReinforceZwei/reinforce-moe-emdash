# EmDash site on Node 22 — Astro standalone server.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
WORKDIR /app
COPY . .
ENV NODE_ENV=production
# `npm run build`, then shrink node_modules to what the running server can actually load.
# Measured on this site: node_modules was 813 MB of a 1.27 GB image, and most of it was either
# never read at runtime (source maps, .d.ts, package docs, the Vite dep cache) or build-only
# tooling.
#
# This only removes what is unambiguously not runtime: dev dependencies, build tools the
# standalone server never loads, and files no interpreter reads. Packages the *server* might
# import are deliberately left alone — `dist/server` externalizes them, so guessing at that list
# breaks the admin or a block type at request time rather than at build time.
RUN npm run build \
 && npm prune --omit=dev \
 # Vite's dev-only dependency cache; `npm run build` leaves it behind.
 && rm -rf node_modules/.vite node_modules/.cache \
 # Build-time only: Astro's bundler (@rolldown, vite) and the TS compiler. The standalone
 # server is plain JS and never loads them. `typescript` only survives `npm prune` because
 # npm auto-installs it as a peer of @astrojs/check.
 && rm -rf node_modules/@rolldown node_modules/rolldown node_modules/vite node_modules/typescript \
 # Never read at runtime: source maps, type declarations, package docs and test fixtures.
 && find node_modules -type f \( -name '*.map' -o -name '*.d.ts' -o -name '*.md' \) -delete \
 && find node_modules -type d \( -name test -o -name tests -o -name docs -o -name examples -o -name .github \) -prune -exec rm -rf {} +

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4321
# SQLite CLI for the `backup` service in docker-compose.yml, which reuses this image with a
# different command. Baked in at build time on purpose: installing it at container start costs
# minutes on a slow link and crash-loops under `restart: always` when `apk` cannot reach the network.
#
# npm, corepack and yarn are removed in the same layer: nothing runs a package manager in this
# container any more, and they only cost image size.
RUN apk add --no-cache sqlite \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-v1.22.22
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
