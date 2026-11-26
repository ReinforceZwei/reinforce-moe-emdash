import { definePlugin } from "emdash";

/**
 * Slug from title: an opt-in "regenerate the slug" control in the editor sidebar.
 *
 * Why it exists: the sidebar slug follows the title only until the entry is saved for the first
 * time. The editor gates that on `slugTouched = useState(!!item?.slug)`, so every saved draft —
 * including one whose title was a placeholder at first save — keeps the slug it got then, and no
 * built-in control re-derives it. Co-editing rooms take the other branch (`withRoomAutoSlug`),
 * which is why the behaviour differs on the same site.
 *
 * Why a trusted React panel and not a hook or route: `slug` is a system column, not a collection
 * field. `content:beforeSave` receives and returns the data record only, `ctx.content.update`
 * rejects `slug` as an unknown field, and the sandboxed editor-draft channel resolves through the
 * collection schema, so none of them can name it. EmDash 1.6.0 gives a native plugin's
 * `contentEditorPanels` component `editorDraft` (`get()` / `patch()`), whose snapshot includes
 * `slug` beside the field values — the one surface that can put a slug into the form.
 *
 * Opt-in on purpose: an imported WordPress slug that does not match its title is never rewritten
 * until somebody presses the button, and typing in the slug field directly still locks it.
 */
export function createPlugin() {
  return definePlugin({
    id: "slug-tools",
    version: "0.1.0",
    admin: {
      // Trusted panel: `adminEntry` in astro.config.mjs loads this module into the admin app, and
      // its `contentEditorPanels` export is discovered from there. No route, no storage, no
      // capability — every read and write happens in the open editor.
      entry: "/src/plugins/slug-tools/admin.tsx",
    },
  });
}
