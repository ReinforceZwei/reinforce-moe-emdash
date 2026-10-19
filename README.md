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

Required environment:

| Variable | Purpose |
| --- | --- |
| `EMDASH_SITE_URL` | Public origin (also used for image optimisation and auth redirects) |
| `EMDASH_ENCRYPTION_KEY` | `emdash_enc_v1_…` — generate with `npx emdash secrets generate` |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION`, `S3_PUBLIC_URL` | Media storage |

The first request runs EmDash migrations and applies the seed's content model. Open `/_emdash/admin` to complete setup
(passkey registration) and create the first admin.

## Notes

- Content was imported from the WordPress REST API and converted to Portable Text; scripts live outside this repo.
- Post cards fall back to the first inline image because list queries do not expand the `featured_image` media object.
- Admin auth is passkey-only, and WebAuthn requires a secure context — reach the admin over `localhost` (SSH tunnel), not a plain-HTTP LAN or tailnet address.
- Back up `data/` (the database plus `-wal`/`-shm`) and the bucket separately; media bytes do not live in the database.
