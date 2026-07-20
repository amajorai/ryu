// Shared helpers for turning a widget's resolved `value` (arbitrary JSON from its
// source) plus its `config` into the shape a widget body renders. Defensive: a
// source can return anything, so every accessor tolerates the unexpected.

/** A plain object, or null if the value is not one. */
export function asRecord(value: unknown): Record<string, unknown> | null {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	return null;
}

/** Walk a dotted path ("a.b.0") into a value; undefined when it misses. */
export function dottedGet(value: unknown, path: string): unknown {
	if (!path) {
		return value;
	}
	let cur: unknown = value;
	for (const seg of path.split(".")) {
		if (Array.isArray(cur)) {
			const i = Number.parseInt(seg, 10);
			cur = Number.isNaN(i) ? undefined : cur[i];
		} else if (cur && typeof cur === "object") {
			cur = (cur as Record<string, unknown>)[seg];
		} else {
			return undefined;
		}
		if (cur === undefined) {
			return undefined;
		}
	}
	return cur;
}

/** Coerce a value to a finite number, or null. */
export function toNumber(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "string") {
		const n = Number.parseFloat(value);
		return Number.isNaN(n) ? null : n;
	}
	return null;
}

/**
 * Resolve a number from a widget value: an explicit `key` (dotted) if given,
 * else the value itself, else the length of an array, else a record's first
 * numeric field, else null.
 */
export function resolveNumber(value: unknown, key?: string): number | null {
	if (key) {
		return toNumber(dottedGet(value, key));
	}
	const direct = toNumber(value);
	if (direct !== null) {
		return direct;
	}
	if (Array.isArray(value)) {
		return value.length;
	}
	const record = asRecord(value);
	if (record) {
		for (const v of Object.values(record)) {
			const n = toNumber(v);
			if (n !== null) {
				return n;
			}
		}
	}
	return null;
}

/**
 * Resolve an array of rows from a widget value: an explicit `key` (dotted) if
 * given, else the value if it is already an array, else the first array-valued
 * field of a record, else [].
 */
export function resolveArray(value: unknown, key?: string): unknown[] {
	if (key) {
		const at = dottedGet(value, key);
		return Array.isArray(at) ? at : [];
	}
	if (Array.isArray(value)) {
		return value;
	}
	const record = asRecord(value);
	if (record) {
		for (const v of Object.values(record)) {
			if (Array.isArray(v)) {
				return v;
			}
		}
	}
	return [];
}

/** Compact, human-readable rendering of a primitive cell value. */
export function cell(value: unknown): string {
	if (value === null || value === undefined) {
		return "";
	}
	if (typeof value === "object") {
		return JSON.stringify(value);
	}
	return String(value);
}

/** Union of keys across an array of record rows, preserving first-seen order. */
export function inferColumns(rows: unknown[]): string[] {
	const seen: string[] = [];
	for (const row of rows) {
		const record = asRecord(row);
		if (!record) {
			continue;
		}
		for (const k of Object.keys(record)) {
			if (!seen.includes(k)) {
				seen.push(k);
			}
		}
	}
	return seen;
}
