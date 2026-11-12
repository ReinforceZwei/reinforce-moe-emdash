# site-stats backfill (WP Statistics → EmDash)

Imports the history from a WordPress + WP Statistics database dump into the `site-stats` plugin.
The dump holds visitor hashes and user rows: never commit it, the SQLite made from it, or
anything else derived from it except the final aggregate (which has no per-visitor data).

## 1. Build the aggregate (dev machine)

```sh
python3 scripts/site-stats-backfill/load-wp-dump.py dump.sql[.gz] wp.db
node scripts/site-stats-backfill/build.mjs wp.db aggregate.json   # Node >= 22.18 (runs the plugin's .ts libs)
```

`build.mjs` reuses the plugin's UA, referrer and bot code so imported days are classified like
live ones, and refuses to run if the WP timezone has a different UTC offset from the plugin's
(`Asia/Hong_Kong`). What it filters, and why:

| Dropped | Reason |
| --- | --- |
| Bots by UA, WP `device = bot`, UA-less rows with unknown agent | not people |
| Visitors whose referrer contains `<script` | vulnerability scanner probes |
| Page rows whose URI contains `<script` | same |
| Page types with no EmDash equivalent (author, archive, search, `/page/N`, sitemaps) | not tracked live |

Referrers that point at the site itself count as *direct* (WP stores the site URL for direct visits).
Page views come from WP's page table, which cannot be filtered per visitor, so per-page totals
can include some bot traffic that the daily totals exclude.

## 2. Run it against the site (remote host)

The image does not ship `scripts/`, so mount the script and the aggregate into a one-off container
that uses the same volume as the app:

```sh
mkdir -p backfill && cp backfill-site-stats.mjs aggregate.json backfill/
docker compose run --rm --no-deps -v "$PWD/backfill:/backfill:ro" app \
  node /backfill/backfill-site-stats.mjs /backfill/aggregate.json          # dry run
docker compose run --rm --no-deps -v "$PWD/backfill:/backfill:ro" app \
  node /backfill/backfill-site-stats.mjs /backfill/aggregate.json --apply   # backup + write
```

- The site keeps running. The import is one short transaction (WAL, 30 s busy timeout).
- `--apply` first writes `pre-site-stats-backfill-<timestamp>.db` (`VACUUM INTO`) next to the database,
  i.e. in `./data/` on the host. Delete it once you are happy.
- Only days **before the first live day** are imported, so nothing is counted twice.
- Requires the monthly-rollup release (#45). Whole months go straight into the rollup
  (`pagesm`/`dimsm` plus a `rollup:YYYY-MM` marker); per-day page/dim rows are written only for the
  last 400 days and for the month the live data starts in, which the plugin rolls up itself when
  that month ends. Refuses to run if that month was already rolled up.
- Imported rows carry `seed: 1`. A ledger row (`totals/backfill`) records exactly what was added to
  the all-time totals.

## 3. Verify

Open *Site stats → Overview* (Last 365 days) and compare with the dry-run numbers; open a post in the
editor and check its Views panel.

## 4. Roll back

```sh
docker compose run --rm --no-deps -v "$PWD/backfill:/backfill:ro" app \
  node /backfill/backfill-site-stats.mjs --rollback
```

Deletes every `seed: 1` row (including rollup rows and markers) and subtracts the ledger from the totals, leaving live counts untouched
(verified: the plugin storage is byte-identical to its pre-import state). If anything looks wrong
beyond that, stop the app and copy the `pre-site-stats-backfill-*.db` file over `emdash.db`
(delete any `-wal`/`-shm` files first).
