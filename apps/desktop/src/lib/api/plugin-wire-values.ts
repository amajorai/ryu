import { z } from "zod";

/** Plugin HTTP transport metadata is JSON, as declared by Core serde serializers. */
const jsonValueSchema = z.json();
const jsonRecordSchema = z.record(z.string(), z.unknown());
export const pluginValueSchema = z.custom<z.output<typeof jsonValueSchema>>(
	(value) => {
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
	}
);
export type PluginValue = z.output<typeof pluginValueSchema>;
const pluginDocumentInputSchema = z.record(z.string(), pluginValueSchema);
export type PluginDocument = z.output<typeof pluginDocumentInputSchema>;
export const pluginDocumentSchema = z.custom<PluginDocument>(
	(value) =>
		pluginValueSchema.safeParse(value).success &&
		pluginDocumentInputSchema.safeParse(value).success
);
export function pluginRecord(
	value: Parameters<typeof pluginDocumentSchema.parse>[0]
) {
	const parsed = pluginDocumentSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}
export function pluginStringField(
	value: Parameters<typeof pluginValueSchema.parse>[0]
) {
	const parsed = z.string().safeParse(value);
	return parsed.success ? parsed.data : undefined;
}
export function pluginBooleanField(
	value: Parameters<typeof pluginValueSchema.parse>[0]
) {
	const parsed = z.boolean().safeParse(value);
	return parsed.success ? parsed.data : undefined;
}
