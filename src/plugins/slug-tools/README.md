# Slug from title

A trusted React editor panel that puts a **Use title as slug** button in the entry sidebar. It
fills the slug field from the title, including changes the user has not saved yet, and marks the
entry as unsaved so the regular save (or autosave) applies it.

## Why it is needed

The sidebar slug follows the title only until the entry is saved for the first time. The editor
gates that on `slugTouched = useState(!!item?.slug)`, so once a draft exists its slug is
indistinguishable from a hand-typed one and no later title edit touches it. There is no built-in
control that re-derives it. Co-editing rooms behave differently (`withRoomAutoSlug` keeps
following while the slug is still the derived one), which is why the same site can behave two
ways.

## Why a trusted panel, and not a hook or a route

`slug` is a **system column**, not a collection field, so no server-side surface can name it:

| Surface | Why it cannot set the slug |
| --- | --- |
| `content:beforeSave` | Receives and returns the **data** record; `slug` is a sibling of `data` on the request body, so a returned `slug` key is dropped. |
| `ctx.content.update` | `ContentWriteInput` is field slugs only; `updateDraftAware` throws `Unknown field 'slug' in collection`. |
| `admin.editorPanels` (sandboxed) + `draft.patch` | Selectors resolve through `collection.fields`; `validateEditorDraftPatch` answers `EDITOR_DRAFT_FIELD_FORBIDDEN` for `slug`. |
| `contentEditorPanels` (trusted, **this plugin**) | The component receives `editorDraft`, whose `get()` snapshot includes `slug`, and `patch()` writes it into the form. |

`editorDraft` was added in EmDash **1.6.0** (PR emdash-cms/emdash#4626). On older hosts the panel
renders a note instead of a button, so the plugin is safe on both.

## Behaviour

- **Opt-in.** Nothing is rewritten until the button is pressed. An imported WordPress slug that
  does not match its title (or any hand-written slug) is never touched.
- **Same as typing.** `patch({ op: "set", field: "slug" })` sets `slugTouched`, so the slug stops
  following the title afterwards; the entry goes dirty and the first save keeps the previous draft
  in the revision history.
- **Where the new slug lands.** On a collection with revisions, the save stores it in the draft
  revision (`_slug`) and the routing row gets it at publish, so a live entry keeps answering on its
  old URL until it is published again — at which point EmDash writes the automatic `301` (verified:
  `/blog/test-emdash-image-upload` → 200, `/blog/test-emdash-image` → 301).
- **Fresh read on every press.** The patch is sent with the `expectedRevision` of a snapshot read
  in the same click, so a keystroke made while the panel was open cannot be clobbered — the editor
  refuses with `EDITOR_DRAFT_STALE` instead.
- **Same generator.** `slugify` is imported from `@emdash-cms/admin/slugify` — the module the
  editor and the server use — so output cannot drift from a title-derived slug (NFKC, lowercase,
  whitespace/underscores to hyphens, punctuation dropped, CJK kept, 80 graphemes).

## Limits

- Reads `fields.title`. A collection whose title field has another slug gets the "no title"
  message; that is the only place the panel is opinionated about the schema.
- Does not check slug uniqueness: EmDash only enforces it across locales
  (`assertAliasAwareSlugAvailable`), and a single-locale site will accept a duplicate. Two posts
  with the same title, one renamed after the other, is the case to watch.
- Panels render only for **saved** entries, which is exactly where the slug has stopped following
  the title.

## Files

| File | Role |
| --- | --- |
| `index.ts` | `definePlugin()` with `admin.entry`, so the host loads the React module. |
| `admin.tsx` | The panel component and its `contentEditorPanels` export. |

Registered in `astro.config.mjs` with `adminEntry`, which is what bundles `admin.tsx` into the
admin app. `@cloudflare/kumo` and `@emdash-cms/admin` are host packages: they resolve from the
admin bundle and are deliberately not site dependencies (same as `comment-groups`).
