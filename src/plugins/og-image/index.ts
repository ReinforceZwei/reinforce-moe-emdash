/**
 * Open Graph image for social cards.
 *
 * Why a plugin: EmDash's own og:image comes from the page context, which is
 * the *original upload* (`https://media.reinforce.moe/<key>.png` — megabytes),
 * and `EmDashHead` re-derives that value from the SEO panel on every content
 * page, overwriting whatever the template passed. Plugin contributions are
 * resolved first (`[...plugin, ...site, ...base]`, first-wins), so this hook
 * is the only place that can guarantee the card points at a resized derivative
 * no matter how the image was chosen.
 *
 * The URL rule itself lives in src/lib/og-image.ts, shared with `resolveSeo()`
 * so the page context, the OG tags and the JSON-LD image stay in agreement.
 * Dimensions are emitted only for URLs this code generated, so they always
 * describe the file the scraper will actually download.
 */
import { definePlugin } from "emdash";
import { buildOgImage } from "../../lib/og-image";

/** `page.siteUrl` is set by the layout; fall back to the request origin. */
function siteOrigin(url: string, siteUrl?: string | null): string {
  if (siteUrl && /^https?:\/\//i.test(siteUrl)) return new URL(siteUrl).origin;
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

export function createPlugin() {
  return definePlugin({
    id: "og-image",
    version: "1.0.0",
    hooks: {
      "page:metadata": ({ page }) => {
        const image = buildOgImage(page.image, siteOrigin(page.url, page.siteUrl));
        if (!image) return null;

        const alt = page.pageTitle ?? page.title ?? "";

        const contributions = [
          { kind: "property" as const, property: "og:image", content: image.url },
          { kind: "property" as const, property: "og:image:type", content: image.type },
          { kind: "property" as const, property: "og:image:width", content: String(image.width) },
          { kind: "property" as const, property: "og:image:height", content: String(image.height) },
          { kind: "meta" as const, name: "twitter:image", content: image.url },
        ];

        if (alt) {
          contributions.push(
            { kind: "property" as const, property: "og:image:alt", content: alt },
            { kind: "meta" as const, name: "twitter:image:alt", content: alt },
          );
        }

        return contributions;
      },
    },
  });
}
