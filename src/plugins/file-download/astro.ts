/**
 * Astro entry for the file-download plugin.
 *
 * EmDash imports `blockComponents` from the descriptor's `componentsEntry` and
 * merges it into its own `<PortableText>` map (built-ins, then plugins, then
 * the site's own components). Keys are the Portable Text `_type` values
 * declared in index.ts.
 */
import FileDownload from "./FileDownload.astro";

export const blockComponents = {
  attachment: FileDownload,
};
