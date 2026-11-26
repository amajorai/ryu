import { z } from "zod";

// The one rule for a host method that hands Core's rows to an app frame: the
// frame gets a NEW object that holds the listed fields and nothing else. A
// field Core adds later stays on the host until someone lists it.

/**
 * Build a new object from the listed own fields of `value`. Everything else is
 * dropped, and so is a listed field that is absent or undefined. Returns
 * undefined when `value` is not a plain record, so nothing passes by accident.
 */
export function pickAllowlistedFields(
	value: unknown,
	fields: readonly string[]
): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return;
	}
	// fromEntries defines own data properties, so no listed name can reach the
	// prototype of the new object.
	return Object.fromEntries(
		Object.entries(value).filter(
			([name, field]) => fields.includes(name) && field !== undefined
		)
	);
}

/**
 * Schema for one record an app frame may receive. The field list is the shape
 * of `fields`. Parsing first copies those fields into a new object and then
 * validates the copy, so the result never holds an unlisted field, whatever
 * object mode `fields` was built with (strip, loose or catchall).
 *
 * The rule is per record: give a nested record its own `allowlistRecord`, and
 * do not list a field typed as free JSON unless the frame may have all of it.
 */
export function allowlistRecord<S extends z.ZodObject>(fields: S) {
	const names = Object.keys(fields.shape);
	return z.preprocess((value) => pickAllowlistedFields(value, names), fields);
}

/** Schema for a list of allowlisted records. Parsing returns a new array. */
export function allowlistRows<S extends z.ZodType>(row: S) {
	return z.array(row);
}
