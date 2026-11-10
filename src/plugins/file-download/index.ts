/**
 * File download block for Portable Text.
 *
 * Why a plugin: EmDash has no attachment block in the editor. The Media
 * Library accepts PDFs and the media route already sends
 * `Content-Disposition: attachment` for them, but a post can only reach a file
 * by pasting its URL into the link mark — there is no slash command, no
 * Media Library picker in the link popover, and no download card.
 *
 * `admin.portableTextBlocks` adds the editor half (slash command + a modal
 * built from Block Kit fields; `media_picker` gives authors the real library
 * picker). The public half is `src/astro.ts` (`blockComponents`), wired
 * through `componentsEntry` in astro.config.mjs, so `<PortableText>` renders
 * `attachment` blocks with FileDownload.astro.
 *
 * The saved block is a plain Portable Text object with the field `action_id`s
 * flattened onto it:
 *
 *   { "_type": "attachment", "_key": "...",
 *     "file": "/_emdash/api/media/file/<storageKey>",
 *     "label": "Download the report (PDF)",
 *     "description": "2025 annual results" }
 *
 * `attachment` deliberately does not reuse the core `file` block type: that
 * one is the WordPress-import block (emdash/src/components/File.astro), and a
 * plugin renderer for `file` would override it for imported content too.
 */
import { definePlugin } from "emdash";

export function createPlugin() {
  return definePlugin({
    id: "file-download",
    version: "1.0.0",
    admin: {
      portableTextBlocks: [
        {
          type: "attachment",
          label: "File download",
          // No dedicated file icon in the editor's icon map (video, code,
          // link, link-external, form); "link" is the closest.
          icon: "link",
          description: "Attach a PDF from the Media Library",
          // The default category is "Embeds"; this belongs with the other
          // media blocks.
          category: "Media",
          fields: [
            {
              type: "media_picker",
              action_id: "file",
              label: "File",
              // `mime_type_filter` is a MIME prefix and defaults to "image/".
              // application/pdf is the only document type the upload
              // allowlist accepts (GLOBAL_UPLOAD_ALLOWLIST).
              mime_type_filter: "application/pdf",
              placeholder: "/_emdash/api/media/file/…",
            },
            {
              type: "text_input",
              action_id: "label",
              label: "Link text",
              placeholder: "Download the report (PDF)",
            },
            {
              type: "text_input",
              action_id: "description",
              label: "Description",
              placeholder: "Optional line under the link text",
              multiline: true,
            },
          ],
        },
      ],
    },
  });
}
