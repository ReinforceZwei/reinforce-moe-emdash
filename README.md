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

EmDash adapters are chosen in `astro.config.mjs`; the S3 adapter reads `S3_*` variables at boot, so the image can be built once and configured per environment.

## Layout

```
src/
├── layouts/Base.astro          # page shell: EmDash head/body, header, footer, global CSS
├── layouts/Archive.astro       # title + post list + pagination (/posts, category, tag)
├── components/                 # Header, Footer, PostPreview, Post, Page, PostList, Pagination,
│                               # WidgetSlot, CategoryList, TagList, MyProfile (fallbacks)
├── pages/
│   ├── index.astro             # home: widget slots around the post list
│   ├── search.astro            # results page for the search widget
│   ├── [slug].astro            # static pages
│   ├── posts/[slug].astro      # post detail (Portable Text + comments)
│   ├── posts/index.astro       # all posts
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

Required environment:

| Variable | Purpose |
| --- | --- |
| `EMDASH_SITE_URL` | Public origin (also used for image optimisation and auth redirects) |
| `EMDASH_ENCRYPTION_KEY` | `emdash_enc_v1_…` — generate with `npx emdash secrets generate` |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION`, `S3_PUBLIC_URL` | Media storage |

The first request runs EmDash migrations and applies the seed's content model. Open `/_emdash/admin` to complete setup
(passkey registration) and create the first admin.

## Seed

`seed/seed.json` is generated from the running site with `emdash export-seed --with-content all`
(post/page collections, 25 posts, 2 pages, 5 categories, 32 tags, menus, widgets, site settings).

`export-seed` leaves Portable Text image blocks pointing at media IDs from the source database, which
do not exist on any other install. Those references were rewritten to the portable form the seed engine
understands:

```json
"asset": { "$media": { "url": "https://media.reinforce.moe/<storageKey>", "alt": "...", "filename": "..." } }
```

Applying the seed therefore downloads each image (121 files), stores it in the configured storage and
rewrites the block to a real `asset._ref`. Progress on a fresh SQLite database: 27 entries, 37 terms,
120 media created (3 deduplicated by content hash). Pass `--skip-media` to keep external URLs instead
of copying the files.

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
| `PUBLIC_TURNSTILE_SITE_KEY` | renders the Turnstile widget in the form (build-time, public) |
| `EMDASH_TURNSTILE_SECRET_KEY` | server-side verification; the token is ignored without it |

Comment pages are server-rendered per request; if Astro caching is enabled for them, cache hints must
exclude the comment list or moderation will appear to lag.

## Notes

- Content was imported from the WordPress REST API and converted to Portable Text; scripts live outside this repo.
- Post cards fall back to the first inline image because list queries do not expand the `featured_image` media object.
- Admin auth is passkey-only, and WebAuthn requires a secure context — reach the admin over `localhost` (SSH tunnel), not a plain-HTTP LAN or tailnet address.
- Images are optimised through Astro's `/_image` endpoint (`srcset` + WebP), which needs two things: `s3({ publicUrl })` so the media host is authorised at build time, and `width`/`height` on each Portable Text image block — emdash's `<Image>` silently degrades to a plain `<img>` without them. Blocks written by the admin editor carry the dimensions; imported content does not, so run `npm run backfill:image-dimensions -- /app/data/emdash.db` once after importing.
- Back up `data/` (the database plus `-wal`/`-shm`) and the bucket separately; media bytes do not live in the database.

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
container — after an image has migrated, rolling back means restoring the database.

