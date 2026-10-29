import { z } from "zod";

/** Catalog and package metadata are JSON documents published by the control plane. */
const jsonValueSchema = z.json();
const jsonRecordSchema = z.record(z.string(), z.unknown());
export const marketplaceValueSchema = z.custom<
	z.output<typeof jsonValueSchema>
>((value) => {
	try {
		if (!jsonValueSchema.safeParse(value).success) {
			return false;
		}
		const pending = [value];
		const seen = new Set<object>();
		while (pending.length) {
			const current = pending.pop();
			const owner = new Object(current);
			if (seen.has(owner)) {
				continue;
			}
			seen.add(owner);
			const prototype = Object.getOwnPropertyDescriptor(owner, "__proto__");
			if (prototype && !jsonValueSchema.safeParse(prototype.value).success) {
				return false;
			}
			if (Array.isArray(current)) {
				pending.push(...current);
			} else if (jsonRecordSchema.safeParse(current).success) {
				pending.push(...Object.values(owner));
			}
		}
		return true;
	} catch {
		return false;
	}
});
export type MarketplaceValue = z.output<typeof marketplaceValueSchema>;
const marketplaceDocumentInputSchema = z.record(
	z.string(),
	marketplaceValueSchema
);
export type MarketplaceDocument = z.output<
	typeof marketplaceDocumentInputSchema
>;
export const marketplaceDocumentSchema = z.custom<MarketplaceDocument>(
	(value) =>
		marketplaceValueSchema.safeParse(value).success &&
		marketplaceDocumentInputSchema.safeParse(value).success
);
export function marketplaceRecord(
	value: Parameters<typeof marketplaceDocumentSchema.parse>[0]
) {
	const parsed = marketplaceDocumentSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}
export function marketplaceString(
	value: Parameters<typeof marketplaceValueSchema.parse>[0]
) {
	const parsed = z.string().safeParse(value);
	return parsed.success && parsed.data.trim() ? parsed.data.trim() : null;
}
export function marketplaceStringList(
	value: Parameters<typeof marketplaceValueSchema.parse>[0]
) {
	const rows = z.array(z.unknown()).safeParse(value);
	return rows.success
		? rows.data.flatMap((row) => {
				const parsed = z.string().safeParse(row);
				return parsed.success && parsed.data.trim() ? [parsed.data] : [];
			})
		: [];
}
export function marketplaceStringField(
	value: Parameters<typeof marketplaceValueSchema.parse>[0]
) {
	const parsed = z.string().safeParse(value);
	return parsed.success ? parsed.data : undefined;
}
export function marketplaceNumberField(
	value: Parameters<typeof marketplaceValueSchema.parse>[0]
) {
	const parsed = z.number().safeParse(value);
	return parsed.success ? parsed.data : undefined;
}
export function marketplaceNonemptyStrings(
	value: Parameters<typeof marketplaceValueSchema.parse>[0]
) {
	const rows = z.array(z.unknown()).safeParse(value);
	return rows.success
		? rows.data.flatMap((row) => {
				const parsed = z.string().min(1).safeParse(row);
				return parsed.success ? [parsed.data] : [];
			})
		: [];
}
