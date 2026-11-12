/** Normalise a request path: no query/hash, decoded, NFC, no duplicate or trailing slash. */
export function normalisePath(raw: string): string {
	let p = String(raw).slice(0, 400);
	p = p.split("#")[0]!.split("?")[0]!;
	try {
		p = decodeURIComponent(p);
	} catch {
		/* keep the raw form */
	}
	p = p.normalize("NFC").replace(/\/{2,}/g, "/");
	if (!p.startsWith("/")) p = `/${p}`;
	if (p.length > 1) p = p.replace(/\/+$/, "");
	return p || "/";
}

/** Prefix match on a segment boundary: `/admin` excludes `/admin/x` but not `/administrator`. */
export function isExcluded(path: string, prefixes: string[]): boolean {
	const p = normalisePath(path);
	return prefixes.some((raw) => {
		const prefix = normalisePath(raw);
		if (prefix === "/") return false;
		return p === prefix || p.startsWith(`${prefix}/`);
	});
}
