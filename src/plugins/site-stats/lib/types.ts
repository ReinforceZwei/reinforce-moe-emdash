/**
 * The slice of the plugin context this plugin uses. Declared structurally so the counting and
 * reading code can run against an in-memory fake in tests (and so it never imports `emdash`).
 */
export type Where = Record<string, string | number | boolean | null | { gte?: string | number; lte?: string | number; gt?: string | number; lt?: string | number; in?: unknown[] }>;

export interface QueryResult<T> {
	items: Array<{ id: string; data: T }>;
	cursor?: string;
	hasMore: boolean;
}

export interface Coll<T = Record<string, any>> {
	get(id: string): Promise<T | null>;
	getMany(ids: string[]): Promise<Map<string, T>>;
	compareAndSet(id: string, expectedRevision: string | null, data: T): Promise<{ applied: boolean }>;
	updateIf(
		id: string,
		args: { where: Where; set?: Partial<T>; delta?: Record<string, { inc?: number; dec?: number }> },
	): Promise<{ applied: boolean }>;
	query(options?: { where?: Where; orderBy?: Record<string, "asc" | "desc">; limit?: number; cursor?: string }): Promise<QueryResult<T>>;
	deleteMany(ids: string[]): Promise<number>;
}

export interface Store {
	days: Coll;
	pages: Coll;
	dims: Coll;
	totals: Coll;
	seen: Coll;
}

export interface Env {
	storage: Store;
	kv: { get<T>(key: string): Promise<T | null>; set(key: string, value: unknown): Promise<void> };
	settings: { get<T>(key: string): Promise<T | null> };
}

export type DimKind = "channel" | "ref" | "engine" | "word" | "browser" | "os" | "device";
