# File download block

This site-local plugin adds an `attachment` Portable Text block. Authors can
insert it from the slash menu, choose a PDF from the Media Library in the
modal, and render a download card on the public site.

EmDash has no built-in attachment block, and the editor's link popover requires
authors to enter a URL by hand. The custom block provides a Media Library
picker for file downloads.

The `componentsEntry` registration in `astro.config.mjs` is native-only. The
host imports `blockComponents` from that entry at build time and merges those
renderers into `<PortableText>`.
