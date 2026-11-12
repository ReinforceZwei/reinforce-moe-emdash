# Comments by post (proof of concept)

The native plugin adds **Plugins → Comments by post** in EmDash. It groups comments by collection and entry, looks up entry titles, and links to published posts and pages on this site. Use the status filter to review pending, approved, spam, or trashed comments, or choose All. Expand an entry to moderate its comments. The built-in comment inbox remains available.

The browser calls EmDash's authenticated admin APIs directly; no separate database or plugin privileges are used. Moderation uses individual status requests so EmDash's moderation hooks run. Permanent deletion requires the admin permission and also deletes replies.

## Proof-of-concept limitations

- EmDash's inbox is paginated by comment, not by entry. To compute complete groups, this page loads every matching comment page, then makes one content request per entry. Large inboxes will take longer to load. All requests all four statuses, including trash.
- The separate API calls do not form a database snapshot. Concurrent moderation may change counts or cause a comment to be missed during a load; refresh to get a new view.
- Missing, trashed, or inaccessible entries use a collection/ID fallback without a public link. Public URLs reflect this site's `/blog/[slug]` and `/[slug]` routes.
- There is no search, per-entry pagination, or bulk moderation yet. The original EmDash inbox remains available.
