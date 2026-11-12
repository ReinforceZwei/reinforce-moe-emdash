# Comments by post

A native plugin that adds **Plugins → Comments by post** to the EmDash admin: the comment inbox
grouped by the entry each comment belongs to, with the entry's title and public link. The built-in
inbox stays available; this view is for reading a thread in context and moderating it.

- Status tabs with live counts (Pending / Approved / Spam / Trash / All), server-side search over
  author name, email, and body, and per-entry cards you expand to read a thread.
- Moderation goes through the single-comment status route, so EmDash's moderation service and its
  `comment:beforeCreate` / `comment:moderate` / `comment:afterModerate` hooks run. Delete is a
  separate, confirmed action that also removes replies and needs `comments:delete`.
- Every group header links to the entry through the collection's own `urlPattern`, resolved by the
  plugin runtime — the plugin does not hard-code this site's `/blog/{slug}` or `/{slug}` routes.

## What a load costs

Three sources, chosen deliberately:

| Request | Why |
| --- | --- |
| `GET /_emdash/api/admin/comments?status=…&limit=100` | The core inbox is the only source with `search` and `trash`. One request per 100 comments. |
| `GET /_emdash/api/admin/comments/counts` | Four numbers for the tabs — no comment rows. |
| `POST /_emdash/api/plugins/comment-groups/entries` | Plugin route (`entries-route.ts`): titles and public URLs for up to 200 distinct entries per request, from `ctx.content.get()` and `ctx.content.getPublicUrl()`. |

A 256-comment pending inbox spanning 27 entries loads in **5 requests** (3 pages + 1 counts + 1 entry
batch) where a per-entry content lookup would need 30. Switching tabs reuses the cached pages
(`staleTime` 60 s), so going back to a visited tab issues no request at all.

Moderation is optimistic in the cheap direction only: the status endpoint returns the updated row, so
the comment is patched into (or removed from) the cached lists in place and only the counts are
refetched. Deletion invalidates the comment lists instead, because a cascade delete removes replies
the client cannot enumerate.

## Proof-of-concept limits

- EmDash's inbox is paginated by comment, not by entry, so a complete grouping loads every matching
  page. `all` is four inboxes in parallel.
- The calls are not a database snapshot: concurrent moderation can shift counts mid-load. Refresh to
  get a new view.
- Deleted or unreadable entries keep their group with a `collection · entry missing` label and no
  link, so their comments stay moderateable.
- No per-entry pagination or bulk actions yet. Strings are English-only (no Lingui catalog).

## Notes for maintainers

- **Do not add Tailwind utility classes to `admin.tsx`.** The admin's stylesheet is a prebuilt
  `@emdash-cms/admin/dist/styles.css`; it only contains the classes EmDash's own sources emitted.
  Common utilities and every `text-kumo-*` token are there, but responsive variants (`md:…`),
  `break-words`, `divide-kumo-line` and similar are not — they silently do nothing. Layout lives in
  `admin.css`, using `--color-kumo-*` tokens so dark mode comes for free.
- Kumo's `Dialog` ships layout only: give it padding and title/description typography yourself
  (see `.cg-dialog*`), or it renders as bare text in a floating card.
- `ctx.input` is typed `unknown` in a route handler even when `input:` is declared, so the handler
  parses it again with the same schema.
