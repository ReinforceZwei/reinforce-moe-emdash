# Open Graph image plugin

This site-local plugin rewrites `og:image` to a resized derivative.

It needs to run as a plugin rather than as layout code: `EmDashHead` derives
`og:image` from the SEO panel on every content page, and plugin contributions
are resolved before those defaults. This makes the plugin contribution the
layer that can override the default consistently.
