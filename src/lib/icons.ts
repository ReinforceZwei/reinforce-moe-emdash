/**
 * Square icon set generated from the in-repo source art.
 *
 * `src/assets/original.png` stays the single icon file in the repository; this
 * module derives the sizes browsers actually ask for (32 px tab icon, 192 px
 * Android, 180 px Apple touch icon) at build time. Icons are padded to squares
 * on the site background instead of stretched, so iOS does not letterbox a
 * 307×299 source into a 180×180 slot.
 *
 * Admin → Settings → Site favicon wins when an editor sets one; `<SiteHead>`
 * checks that first and only falls back to these.
 *
 * Generation is memoised per process: `<SiteHead>` asks on every render, the
 * image service caches the transform on disk, and the promise is shared so a
 * burst of renders does not queue the same four jobs.
 */

import { getImage } from "astro:assets";

import source from "../assets/original.png";

/** Must match `--color-bg` in src/styles/tokens.css. */
export const SITE_THEME_COLOR = "#fff6f6";

export interface SiteIcons {
  /** 32×32 tab icon. */
  small: string;
  /** 192×192 Android / manifest icon. */
  large: string;
  /** 180×180 apple-touch-icon. */
  apple: string;
}

async function renderIcon(size: number): Promise<string> {
  // `cover` rather than `contain`: the source art is 307×299, and a contained
  // fit yields a 32×31 canvas (letterboxed by the browser, black-padded by
  // iOS). A 4 px-per-side centre crop is invisible at icon sizes and keeps the
  // output exactly square, which is what the `sizes` attributes promise.
  const image = await getImage({
    src: source,
    width: size,
    height: size,
    format: "png",
    fit: "cover",
    position: "centre",
  });
  return image.src;
}

let pending: Promise<SiteIcons> | null = null;

export function getSiteIcons(): Promise<SiteIcons> {
  pending ??= (async () => {
    const [small, large, apple] = await Promise.all([
      renderIcon(32),
      renderIcon(192),
      renderIcon(180),
    ]);
    return { small, large, apple };
  })();

  return pending;
}
