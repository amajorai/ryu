import {
	isNativeNumber,
	isNativeText,
} from "@ryu/ui/lib/native-primitive-observation.ts";
import { z } from "zod";
// Shared helpers for turning a widget's resolved `value` (arbitrary JSON from its
// source) plus its `config` into the shape a widget body renders. Defensive: a
// source can return anything, so every accessor tolerates the unexpected.

export const jsonValueSchema = z.json();
export type JsonValue = z.infer<typeof jsonValueSchema>;
const jsonRecordSchema = z.record(z.string(), jsonValueSchema);
const jsonArraySchema = z.array(jsonValueSchema);

/** Decode the arbitrary JSON supplied by widget sources before accessing fields. */
export function asRecord<TValue>(value: TValue) {
	const parsed = jsonRecordSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}

/** Walk a dotted JSON path ("a.b.0"); undefined when it misses. */
export function dottedGet<TValue>(
	value: TValue,
	path: string
): JsonValue | undefined {
	const parsed = jsonValueSchema.safeParse(value);
	if (!parsed.success) {
		return undefined;
	}
	let cur: JsonValue | undefined = parsed.data;
	if (!path) {
		return cur;
	}
	for (const seg of path.split(".")) {
		if (Array.isArray(cur)) {
			const i = Number.parseInt(seg, 10);
			cur = Number.isNaN(i) ? undefined : cur[i];
		} else {
			const record = asRecord(cur);
			if (!record) {
				return undefined;
			}
			cur = record[seg];
		}
		if (cur === undefined) {
			return undefined;
		}
	}
	return cur;
}

/** Coerce a value to a finite number, or null. */
export function toNumber<TValue>(value: TValue): number | null {
	if (isNativeNumber(value) && Number.isFinite(value)) {
		return value;
	}
	if (isNativeText(value)) {
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
export function resolveNumber<TValue>(
	value: TValue,
	key?: string
): number | null {
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
export function resolveArray<TValue>(value: TValue, key?: string): JsonValue[] {
	if (key) {
		const at = dottedGet(value, key);
		const parsed = jsonArraySchema.safeParse(at);
		return parsed.success ? parsed.data : [];
	}
	const array = jsonArraySchema.safeParse(value);
	if (array.success) {
		return array.data;
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
export function cell<TValue>(value: TValue): string | undefined {
	if (value === null || value === undefined) {
		return "";
	}
	const parsed = z.union([jsonRecordSchema, jsonArraySchema]).safeParse(value);
	if (parsed.success) {
		return JSON.stringify(parsed.data);
	}
	return String(value);
}

/** Union of keys across an array of record rows, preserving first-seen order. */
export function inferColumns(rows: JsonValue[]): string[] {
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
