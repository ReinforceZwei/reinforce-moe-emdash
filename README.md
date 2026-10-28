# reinforce-moe-emdash

[Reinforce.moe](https://reinforce.moe) rebuilt on [EmDash](https://github.com/emdash-cms/emdash) — the Astro-native CMS.
The layout and styles are ported from the previous Astro theme ([reinforce-moe-astro](https://github.com/ReinforceZwei/reinforce-moe-astro));
all content now comes from EmDash collections instead of the Trilium content loader.

## Stack

| Layer | Choice |
| --- | --- |
| Runtime | Node.js 22, Astro 7 (`output: "server"`, `@astrojs/node` standalone) |
| CMS | EmDash 1.3 |
| Database | SQLite (`data/emdash.db`, WAL) |
| Media | S3-compatible object storage (Cloudflare R2, public via `media.reinforce.moe`) |
| Container | Docker + Compose |

EmDash adapters are chosen in `astro.config.mjs`; the S3 adapter reads the credential `S3_*` variables at
boot, so the image can be built once and configured per environment. `S3_PUBLIC_URL` is the exception —
the config passes it explicitly, so it is build-time (see Build-time vs runtime environment).

## Layout

```
src/
├── layouts/Base.astro          # page shell: EmDash head/body, header, footer, global CSS
├── layouts/Archive.astro       # title + post list + pagination (/blog, category, tag)
├── components/                 # Header, Footer, PostPreview, Post, Page, PostList, Pagination,
│                               # WidgetSlot, CategoryList, TagList, MyProfile (fallbacks)
├── pages/
│   ├── index.astro             # home: widget slots around the post list
│   ├── search.astro            # results page for the search widget
│   ├── [slug].astro            # static pages
│   ├── blog/[slug].astro       # post detail (Portable Text + comments)
│   ├── blog/index.astro        # all posts
│   ├── category/[slug].astro   # category archive
│   └── tag/[slug].astro        # tag archive
├── styles/
│   ├── tokens.css              # design tokens: colour, type, measure, space (single source of truth)
│   ├── reset.css               # minimal reset (replaces normalize.css)
│   ├── base.css                # element defaults: headings, links, lists, code, tables, forms
│   ├── prose.css               # Portable Text content contract (replaces trilium.css)
│   ├── comments.css            # themes EmDash's built-in comment components
│   └── widgets.css             # themes EmDash widget areas and core widgets
└── assets/                     # logo, profile image, brand icons
seed/seed.json                  # content model, taxonomies, site settings, widget areas
```

## Styles

There is no vendored CSS. `tokens.css` declares every colour, font size, measure and spacing step;
`reset.css` and `base.css` apply them to bare elements; component `<style>` blocks only reference
`var(--…)`. Nothing outside `tokens.css` should contain a hex colour, a font stack or a `px` width.

| Layer | Owns |
| --- | --- |
| `tokens.css` | palette, type scale, `--measure-wide` (780px), `--measure-prose` (600px), `--space-*` |
| `reset.css` | box-model and UA-default normalisation |
| `base.css` | element defaults (everything `sakura.css` used to own) |
| `prose.css` | `.post-content`: Portable Text output, figures, captions, blockquotes |
| `comments.css` | EmDash comment list/form, re-skinned via its `--ec-*` hooks |
| `widgets.css` | widget areas + core widget markup (`.widget-categories`, `.widget-search`, …) |

## Widgets

The home page has no hardcoded sidebars: three EmDash widget areas replace them, and the old static
content is the fallback shown while an area is empty.

| Area name | Region | Fallback when empty |
| --- | --- | --- |
| `home-spotlight` | strip above the columns | the animated gif |
| `home-left` | left column | `MyProfile` card |
| `home-right` | right column | category + tag lists |

`WidgetSlot.astro` does the guarding: it reads the area, renders `<WidgetArea>` when it has widgets,
otherwise the slotted fallback, and registers the area's cache hint. A bare `<WidgetArea>` renders
nothing when the area is missing, which would blank the region between deploying code and an editor
saving a widget.

Built-in widget types you can drop into any area (Admin → Widgets):

| Type | What it renders |
| --- | --- |
| Content | a Portable Text block — the "content block" widget |
| Menu | a menu by name (e.g. `primary`) |
| Component: `core:search` | search form (`placeholder` prop) |
| Component: `core:categories` | category list (`showCount`, `hierarchical`) |
| Component: `core:tags` | tag cloud (`showCount`, `limit`) |
| Component: `core:recent-posts` | latest posts (`count`, `showThumbnails`, `showDate`, `urlTemplate`) |
| Component: `core:archives` | monthly/yearly archive links (`type`, `limit`) |

`core:search` submits `GET /search?q=`, so the site ships `src/pages/search.astro`: it calls EmDash's
`search()` over `posts` and `pages`, renders the sanitised `<mark>` snippets, and paginates with the
result cursor. The widget's submit button is labelled "Search" upstream and cannot be translated —
only the placeholder is configurable.

`seed/seed.json` pre-populates all three areas for a **fresh** database.

On an existing database, create areas with those exact names in **Admin → Widgets** — that is the
safe path. Seeding is not a targeted migration: `npx emdash seed … --on-conflict update` also
re-applies collections, settings and (unless `--no-content`) every content entry from the seed, so it
would overwrite live edits. If you must script it, at minimum skip content:

```bash
npx emdash seed seed/seed.json --no-content --on-conflict update
```

That still re-applies schema, settings and menus, and it **replaces the widgets of the areas it
touches**, so treat it as a staging/reset tool rather than a production migration.

## Running

```bash
cp .env.example .env            # fill in the values below
docker compose up -d --build
```

Running it locally without Docker (needs Node 22+ and `npm ci`):

```bash
cp .env.example .env
# EMDASH_DB_PATH=./data/emdash.db   (uncomment; the default /app/data/emdash.db is the container mount)
npm run dev
```

`astro.config.mjs` loads `.env` itself, because Astro only reads dotenv files after the config has
been evaluated — without that, `S3_*` and `EMDASH_*` are unset under `astro dev` and the middleware
fails with `MISSING_S3_CONFIG`. Exported environment variables take precedence over `.env`.

Sessions — what keeps a signed-in admin signed in — live in `data/sessions`, beside the database. The
store is pinned in `astro.config.mjs` because @astrojs/node otherwise defaults it to
`node_modules/.astro/sessions`, inside the container layer: every `docker compose up -d` or image
update recreates the container, discards it, and the admin comes back to a 401. Keep `data/` on a
persistent volume (the compose file mounts it) and the sessions survive deploys.

Required environment:

| Variable | Purpose |
| --- | --- |
| `EMDASH_SITE_URL` | Public origin (also used for image optimisation and auth redirects) |
| `EMDASH_ENCRYPTION_KEY` | `emdash_enc_v1_…` — generate with `npx emdash secrets generate` |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION`, `S3_PUBLIC_URL` | Media storage |

The first request runs EmDash migrations and applies the seed's content model. Open `/_emdash/admin` to complete setup
(passkey registration) and create the first admin.

### Build-time vs runtime environment

`astro.config.mjs` is evaluated **once, during `astro build`** — the deployed server never runs it, so
anything the config computes and hands to `emdash()` is frozen as a literal in `dist`. Setting that
variable in compose or `.env` then has no effect, which is invisible as long as the runtime value equals
the baked default:

| Variable | Read where | Changing it needs |
| --- | --- | --- |
| `EMDASH_DB_PATH` (default `/app/data/emdash.db`) | `astro.config.mjs` → `sqlite({ url })` | **a rebuild** |
| `EMDASH_SESSION_PATH` (default `<database dir>/sessions`) | `astro.config.mjs` → session driver `base` | **a rebuild** |
| `S3_PUBLIC_URL` (default `https://media.reinforce.moe`) | `astro.config.mjs` → `s3({ publicUrl })`, which also feeds `image.remotePatterns` | **a rebuild** |
| `EMDASH_SITE_URL`, `EMDASH_ENCRYPTION_KEY`, `EMDASH_PREVIEW_SECRET` | EmDash, at request time | a restart |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION` | the s3 adapter, at boot | a restart |
| `PUBLIC_TURNSTILE_SITE_KEY`, `EMDASH_TURNSTILE_SECRET_KEY` | request time (see Comments) | a restart |

`S3_PUBLIC_URL` is the odd one out among `S3_*`: `resolveS3Config` prefers an explicit value and only
falls back to `process.env` for fields it was not given. The config always supplies `publicUrl` (the env
value or the production default), so the runtime variable is ignored, while bucket, keys, endpoint and
region have no explicit value and are read from the environment at boot.

Consequences: `env_file:` in compose cannot move the database or the media host on an image that is
already built, and the CI build (`.github/workflows/image.yml`) runs with no `S3_*`/`EMDASH_*` variables
at all — so the values baked into a released image are exactly the defaults above. This applies to the
built server only: `astro dev` re-evaluates the config on every start, so every variable behaves like a
runtime one in development.

To check whether a value reached the bundle, build with a unique value for it and search `dist/`; to
check the runtime side, change the variable and watch which path or host the server actually uses.

### Reverse proxy

The site runs behind Traefik, which terminates TLS and forwards `Host`, `X-Forwarded-Host` and
`X-Forwarded-Proto`. Traefik doing that is not enough: Astro only *reflects* forwarded headers for hosts
listed in `security.allowedDomains`. Without the list `Astro.url` stays the internal
`http://localhost:4321`, and every canonical, `og:url` and absolute link built from the request
advertises a host nobody can reach — that is how production shipped `localhost` canonicals.

`astro.config.mjs` therefore hardcodes the public host in `security.allowedDomains` (a literal: the list
is evaluated at build time, so it cannot come from a runtime variable). **Moving to a new domain means
editing that constant and rebuilding**, not just changing `EMDASH_SITE_URL`.

`siteUrl` is not set in the config: EmDash reads `EMDASH_SITE_URL` (then `SITE_URL`) at request time,
which is what passkeys, CSRF checks, email links and sitemaps use.

Requests whose Host is not allow-listed are not rejected — Astro ignores their forwarded headers, so a
spoofed Host cannot inject a canonical.

`trustedProxyHeaders: ["x-forwarded-for"]` is a separate concern: it lets the auth and comment rate
limits count per real client IP instead of putting every visitor in one bucket.

## Email

Magic links, invites and account recovery need a provider plugin for EmDash's `email:deliver` hook.
`emdash-smtp` is installed and registered in `astro.config.mjs`; without it the admin reports "No
email provider is configured" and invites have to be copied by hand.

Its provider credentials are **plugin settings stored in the database**, not environment variables —
the plugin reads no `process.env` at all, so putting an API key in `.env` or compose does nothing.
Paste the key on the plugin's admin page, then pick the provider under Settings → Email (exactly one
delivers at a time) and use **Send test email**. Supported natively, among others: Resend, Postmark,
Amazon SES, Brevo, Mailgun, SendGrid, SMTP2GO, Mailjet, MailerSend, Zoho, Mandrill, plus generic SMTP.

This site sends through Resend from `reinforce.moe` while the domain's MX stays on iCloud+:

- Resend only needs a return-path on `send.reinforce.moe` and its own DKIM selector
  (`resend._domainkey`), neither of which collides with iCloud's `MX @` or `sig1._domainkey` CNAME.
- **Never publish a second `v=spf1` record.** If Resend's dashboard asks for an apex SPF, merge the
  include into the existing one (`v=spf1 include:icloud.com include:amazonses.com ~all`); two SPF
  records at the same name is a permerror and breaks outbound mail through iCloud too.
- Verify a real send by checking a Gmail "Show original" for `spf=pass dkim=pass dmarc=pass` — the
  admin's test button only proves the API accepted the request.

## Seed

`seed/seed.json` is generated from the running site with `emdash export-seed --with-content all`
(post/page collections, 25 posts, 2 pages, 5 categories, 32 tags, menus, widgets, site settings).

`export-seed` leaves Portable Text image blocks pointing at media IDs from the source database, which
do not exist on any other install. Those references were rewritten to the portable form the seed engine
understands:

```json
"asset": { "$media": { "url": "https://media.reinforce.moe/<storageKey>", "alt": "...", "filename": "..." } }
```

Applying the seed therefore downloads each image (123 inline refs plus 16 featured images), stores it in
the configured storage and rewrites the reference to real media. Progress on a fresh SQLite database:
27 entries, 37 terms, ~120 media created (deduplicated by content hash). Pass `--skip-media` to keep
external URLs instead of copying the files.

**Featured images are part of the seed.** Posts that had a featured image on the WordPress site carry
one as a top-level `featured_image: { "$media": { … } }` — the same form as inline blocks — so a seed
with storage produces a real media reference and the card image is optimised. 16 of the 25 posts have
one; the other nine have none on WordPress and therefore render no card image (see Notes). With
`--skip-media` the reference resolves to the external WordPress URL, which Astro serves as a plain
unoptimised `<img>` because the dimensions are unknown.

**Timestamps do not survive a seed.** The seed format has no date fields: `apply.ts` creates every
non-draft entry with `publishedAt: new Date()`, and `export-seed` does not emit the timestamps either.
A freshly seeded site therefore shows all 25 posts as published today and sorts the archive by seed
order. `seed/publish-dates.json` holds the source site's timestamps per slug — `publishedAt`,
`createdAt` and `updatedAt`, taken from the WordPress REST API's `date_gmt` / `modified_gmt` and
converted to UTC — and the backfill applies them:

```bash
npm run backfill:publish-dates -- /app/data/emdash.db --dry-run   # preview
npm run backfill:publish-dates -- /app/data/emdash.db            # write
```

It only rewrites the columns whose value differs, so it is safe to re-run after seeding again.
`updatedAt` is the source's last-modified time, which for most posts is years after publication.

**Slugs are stored decoded.** EmDash keeps `ec_<collection>.slug` as the raw Unicode slug and the
routes call `decodeSlug(Astro.params.slug)` before looking entries up. Content imported with
percent-encoded slugs (`%e7%ac%ac%e4%b8%80...`) therefore never matches and 404s. The backfill
decodes `ec_posts.slug`, `ec_pages.slug` and `taxonomies.slug` in place:

```bash
npm run backfill:decode-slugs -- /app/data/emdash.db --dry-run   # preview
npm run backfill:decode-slugs -- /app/data/emdash.db            # write
```

It only touches encoded values and aborts on decoded collisions, so it is safe to re-run.

A database that was seeded and then imported can hold two rows for the same CJK term — one raw and
one encoded — because `(name, slug, locale)` only collides after decoding. `--dedupe-orphan-terms`
deletes the copy that no content references before decoding:

```bash
npm run backfill:decode-slugs -- /app/data/emdash.db --dedupe-orphan-terms
```

## Comments

Comments use **EmDash's built-in system** (`emdash/ui/comments`), not Giscus. Posts are the only
commentable collection (`"commentsEnabled": true` in `seed/seed.json`), and the post page renders
`<Comments>` (threaded, with reactions) plus `<CommentForm>` with zh-Hant labels.

Why the switch: no GitHub account is needed to comment, nothing is loaded from a third party, storage
and moderation live in the same admin and SQLite database, and spam controls ship with it (honeypot,
per-IP rate limit, optional Turnstile, moderation queue). Giscus instead puts every comment in GitHub
Discussions, requires readers to sign in to GitHub, and cannot be moderated from EmDash.

Enabling on an existing database is a schema change, not a deploy step — `seed.json` only bootstraps a
fresh database:

```bash
npx emdash schema get posts        # confirm commentsEnabled
# toggle in the admin: Content Types → Posts → Comments
```

New comments default to **pending** (`commentsModeration: "all"`) and appear once approved under
Admin → Comments. Configure per collection: moderation mode, auto-approve signed-in users, and
`commentsClosedAfterDays`. Optional spam protection:

| Variable | Purpose |
| --- | --- |
| `PUBLIC_TURNSTILE_SITE_KEY` | renders the Turnstile widget in the form (public; read at request time) |
| `EMDASH_TURNSTILE_SECRET_KEY` | server-side verification; the token is ignored without it |

Both are read from `process.env` **per request**, so they can be set in compose's `env_file` and take
effect after a restart. Do not switch the site key back to `import.meta.env.PUBLIC_…`: Vite inlines
that at build time, which leaves the CI-built image without a widget — and with the secret set,
verification fails closed and every comment is rejected.

Comment pages are server-rendered per request; if Astro caching is enabled for them, cache hints must
exclude the comment list or moderation will appear to lag.

## Notes

- Content was imported from the WordPress REST API and converted to Portable Text; scripts live outside this repo.
- Post cards show **only** the featured image; posts without one render no image (the body's first inline image is deliberately not used). List queries do not expand media, so `src/lib/content/media.ts` accepts an expanded value, an id-only reference with `meta.storageKey`, the internal media route, or a bare URL string — a resolver that handles only one shape silently drops the image.
- Admin auth is passkey-only, and WebAuthn requires a secure context — reach the admin over `localhost` (SSH tunnel), not a plain-HTTP LAN or tailnet address.
- Images are optimised through Astro's `/_image` endpoint (`srcset` + WebP), which needs two things: `s3({ publicUrl })` so the media host is authorised at build time, and `width`/`height` on each Portable Text image block — emdash's `<Image>` silently degrades to a plain `<img>` without them. Blocks written by the admin editor carry the dimensions; imported content does not, so run `npm run backfill:image-dimensions -- /app/data/emdash.db` once after importing.
- Backups are taken online by a sidecar container from the same image (see [Backups](#backups)); the R2 bucket is not covered by it.

## Backups

SQLite is backed up **online** — the site keeps serving writes — by a second container built from
the same image and started with `backup/run.sh` instead of the Astro server (`backup` in
`docker-compose.yml`). `sqlite3` is installed in the runtime stage of the Dockerfile for it, and the
script ships as `/app/backup/run.sh`; nothing else in the image changes.

`.backup` uses SQLite's online backup API, which reads a consistent snapshot without locking the
writers out. Two details are load-bearing:

- The source is opened as `file:…?mode=ro`. Plain `sqlite3` **creates** a missing database, so a
  mistyped path produces an empty "backup" that still passes `PRAGMA integrity_check` — the run
  verifies a table count before publishing for exactly that reason.
- The database directory is mounted read-write anyway: a WAL reader needs the `-shm` file beside the
  database, and a read-only mount fails with `unable to open database file`.

Each run writes `emdash-<UTC timestamp>.db` plus a `.sha256`, checks the copy (table count, then
`integrity_check`), and only then renames it out of `.<name>.partial` — a collector globbing `*.db`
never sees a half-written file. `LAST_SUCCESS` holds the epoch of the last good run.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DB_PATH` | `/app/data/emdash.db` | database to copy |
| `OUT_DIR` | `/app/backups` | where backups land — the volume the collector reads |
| `INTERVAL` | `21600` | seconds between backups |
| `KEEP` | `7` | backups kept before the oldest is pruned (the compose service sets `28`) |
| `MIN_TABLES` | `80` | floor for the sanity check; an empty database has 0 |

The schedule is a `sleep` loop that also backs up once at startup when `LAST_SUCCESS` is older than
`INTERVAL`. That catch-up is the point: every deploy and image update recreates this container, so a
bare `sleep 21600` loop combined with frequent deploys could never fire. No cron, so there is no
crontab ownership trap and job output goes straight to `docker compose logs backup`. `TERM` is
trapped, which makes `docker stop` immediate.

Pruning lives in this container, so `KEEP` must stay well above the collector's worst-case lag —
`28 × 6 h` is seven days of files on the volume.

In production the service only needs the published tag — no `env_file` (the encryption key and R2
credentials have no business here), no `proxy` network, no Traefik labels:

```yaml
  backup:
    image: ghcr.io/reinforcezwei/reinforce-moe-emdash:X.Y.Z
    restart: always
    mem_limit: 128m
    read_only: true
    tmpfs: ["/tmp"]
    security_opt: ["no-new-privileges:true"]
    environment:
      TZ: UTC
      KEEP: "28"
      INTERVAL: "21600"
    volumes:
      - ./data:/app/data
      - ./backups:/app/backups
    command: ["/bin/sh", "/app/backup/run.sh"]
```

### Verifying a backup

```bash
sqlite3 emdash-20261027T075110Z.db "PRAGMA integrity_check"        # ok
sqlite3 emdash-20261027T075110Z.db "select count(*) from ec_posts" # non-zero on a used site
sha256sum -c emdash-20261027T075110Z.db.sha256
```

Neither of those proves recovery. The rehearsal is: start the app image with the backup in place of
`data/emdash.db`, then confirm the site renders, the admin signs in (users **and** passkeys live in
the database), an edit saves, and a media URL resolves.

### Restore

1. `docker compose stop app` — and stop the collector, so it does not pick up the file you are
   restoring.
2. Move the damaged database aside rather than deleting it: `data/emdash.db`, `data/emdash.db-wal`,
   `data/emdash.db-shm`.
3. `cp emdash-<timestamp>.db data/emdash.db && rm -f data/emdash.db-wal data/emdash.db-shm`. Dropping
   the stale `-wal`/`-shm` is not optional: a leftover WAL beside a replaced database is how a
   restored site comes back looking corrupt.
4. `docker compose start app`, then verify pages, admin sign-in and one image.
5. Confirm `EMDASH_ENCRYPTION_KEY` is the one the backup was taken with, then open Settings → Email
   and check the stored plugin secret still decrypts.

### What this does not cover

- **`EMDASH_ENCRYPTION_KEY` and its rotation list** — not in the database, not recoverable from it.
  A restored database plus a different key leaves the plugin secrets unreadable. Keep `.env` in a
  secret manager.
- **Media bytes** — they live in R2, so database rows alone restore a site with broken images. Rely
  on bucket versioning or a separate `aws s3 sync` with read-only credentials.
- **Off-host copies** — `./backups` is on the same host as the database. Whatever reads that volume
  must write somewhere else, or losing the host loses the backups with it.
- EmDash's own JSON backups (Settings → Backups) are for inspection only: EmDash cannot restore them.

## Releasing

Container images are published to GHCR by `.github/workflows/image.yml`:

| Trigger            | Tags published                                          |
| ------------------ | ------------------------------------------------------- |
| push to `main`     | `edge`, `sha-<short>` — staging/preview only            |
| tag `vX.Y.Z`       | `X.Y.Z`, `X.Y`, `X`, `latest` + a GitHub Release        |

```bash
./release.sh patch          # or minor / major
./release.sh minor -p       # -p also runs git push && git push --tags
./release.ps1 minor -p      # Windows
```

`release.sh` calls `npm version`, which bumps `package.json` and `package-lock.json`, commits
`chore(release): vX.Y.Z` and creates the `vX.Y.Z` tag that CI builds from. Bump rules: **major** when
the release needs a content or data action (DB/storage adapter change, route or seed format change),
**minor** for template/feature work, **patch** for dependency bumps and fixes.

Production pins the full `X.Y.Z` tag (or its digest); `latest` is only ever published from a tag.
Migrations run forward on the first request after deploy, so back up `data/` before swapping the
container ([Backups](#backups)) — after an image has migrated, rolling back means restoring the database.
