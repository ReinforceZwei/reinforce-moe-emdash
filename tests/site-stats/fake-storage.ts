import type { Coll, Env, Store, Where } from "../../src/plugins/site-stats/lib/types.ts";

type Row = Record<string, any>;

function matches(data: Row, where: Where = {}): boolean {
	return Object.entries(where).every(([field, cond]) => {
		const v = data[field];
		if (cond !== null && typeof cond === "object") {
			const c = cond as Record<string, any>;
			if (c.gte !== undefined && !(v >= c.gte)) return false;
			if (c.gt !== undefined && !(v > c.gt)) return false;
			if (c.lte !== undefined && !(v <= c.lte)) return false;
			if (c.lt !== undefined && !(v < c.lt)) return false;
			if (c.in !== undefined && !c.in.includes(v)) return false;
			return true;
		}
		return v === cond;
	});
}

export function fakeColl(): Coll & { rows: Map<string, Row> } {
	const rows = new Map<string, Row>();
	return {
		rows,
		async get(id) {
			return rows.get(id) ?? null;
		},
		async getMany(ids) {
			return new Map(ids.filter((i) => rows.has(i)).map((i) => [i, rows.get(i)!]));
		},
		async compareAndSet(id, rev, data) {
			if (rev !== null || rows.has(id)) return { applied: false };
			rows.set(id, { ...data });
			return { applied: true };
		},
		async updateIf(id, { where, set, delta }) {
			const row = rows.get(id);
			if (!row || !matches(row, where)) return { applied: false };
			Object.assign(row, set);
			for (const [k, d] of Object.entries(delta ?? {})) row[k] = (row[k] ?? 0) + (d.inc ?? 0) - (d.dec ?? 0);
			return { applied: true };
		},
		async query({ where, orderBy, limit = 50, cursor } = {}) {
			let items = [...rows.entries()].filter(([, d]) => matches(d, where)).map(([id, data]) => ({ id, data }));
			const [field, dir] = Object.entries(orderBy ?? {})[0] ?? [];
			if (field) items.sort((a, b) => (a.data[field] < b.data[field] ? -1 : a.data[field] > b.data[field] ? 1 : 0) * (dir === "desc" ? -1 : 1));
			const start = cursor ? Number(cursor) : 0;
			const slice = items.slice(start, start + limit);
			const more = start + limit < items.length;
			return { items: slice, hasMore: more, cursor: more ? String(start + limit) : undefined };
		},
		async deleteMany(ids) {
			return ids.filter((i) => rows.delete(i)).length;
		},
	};
}

export function fakeEnv(settings: Record<string, unknown> = {}): Env & { storage: Store & Record<string, ReturnType<typeof fakeColl>> } {
	const kvData = new Map<string, unknown>();
	return {
		storage: { days: fakeColl(), pages: fakeColl(), dims: fakeColl(), pagesm: fakeColl(), dimsm: fakeColl(), totals: fakeColl(), seen: fakeColl() } as any,
		kv: {
			async get<T>(k: string) {
				return (kvData.get(k) as T) ?? null;
			},
			async set(k, v) {
				kvData.set(k, v);
			},
		},
		settings: {
			async get<T>(k: string) {
				return (settings[k] as T) ?? null;
			},
		},
	};
}
