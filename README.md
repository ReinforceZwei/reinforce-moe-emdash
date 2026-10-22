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
├── components/                 # Header, Footer, PostPreview, Post, Page, CategoryList, TagList, Spotlight, MyProfile
├── pages/
│   ├── index.astro             # three-column home: spotlight, profile, posts, taxonomies
│   ├── [slug].astro            # static pages
│   ├── posts/[slug].astro      # post detail (Portable Text)
│   ├── posts/index.astro       # all posts
│   ├── category/[slug].astro   # category archive
│   └── tag/[slug].astro        # tag archive
├── styles/                     # sakura-pink.css, trilium.css, normalize.css
└── assets/                     # logo, profile image, brand icons
seed/seed.json                  # content model, taxonomies, site settings
```

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

