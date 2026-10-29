import { z } from "zod";
/** Small, serializable metadata for one plugin-owned wallpaper variant. */
export interface PluginBackground {
	attribution: string;
	attributionUrl: string;
	backdropId: string;
	description?: string;
	id: string;
	label: string;
	params: PluginBackdropParams;
	plugin: string;
}

export function hasControlCharacters(value: string): boolean {
	for (const character of value) {
		const code = character.charCodeAt(0);
		if (code < 0x20 || code === 0x7f) {
			return true;
		}
	}
	return false;
}

export function isValidPluginId(value: string): boolean {
	const isFlatId = (part: string) =>
		part.length > 0 &&
		part.length <= 128 &&
		!part.includes("..") &&
		!part.startsWith(".") &&
		!part.startsWith("-") &&
		!part.endsWith(".") &&
		/^[A-Za-z0-9._-]+$/.test(part);
	if (value.length > 128) {
		return false;
	}
	if (!value.startsWith("@")) {
		return isFlatId(value);
	}
	const parts = value.slice(1).split("/");
	return parts.length === 2 && parts.every(isFlatId);
}

function isSafeAttributionUrl(value: string): boolean {
	if (
		value.length > 2048 ||
		value !== value.trim() ||
		hasControlCharacters(value)
	) {
		return false;
	}
	try {
		const url = new URL(value);
		return (
			url.protocol === "https:" &&
			url.hostname.length > 0 &&
			url.username.length === 0 &&
			url.password.length === 0
		);
	} catch {
		return false;
	}
}

const boundedTextSchema = z
	.string()
	.max(128)
	.refine((value) => !hasControlCharacters(value));
const backdropParameterSchema = z.union([
	boundedTextSchema,
	z.number(),
	z.boolean(),
	z.array(boundedTextSchema).max(16),
]);
const backdropParameterKeySchema = z
	.string()
	.regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/)
	.refine((key) => key !== "constructor" && key !== "prototype");
const backdropParamsInputSchema = z
	.record(backdropParameterKeySchema, backdropParameterSchema)
	.refine(
		(value) =>
			Object.keys(value).length <= 64 &&
			new TextEncoder().encode(JSON.stringify(value)).byteLength <= 4096
	);
export type PluginBackdropParams = z.output<typeof backdropParamsInputSchema>;
const backdropParamsSchema = z.custom<PluginBackdropParams>(
	(value) => backdropParamsInputSchema.safeParse(value).success
);
const pluginBackgroundInputSchema = z
	.object({
		attribution: boundedTextSchema.refine((value) => value.trim().length > 0),
		attributionUrl: z.string().refine(isSafeAttributionUrl),
		backdropId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/),
		description: z
			.string()
			.max(512)
			.refine((value) => !hasControlCharacters(value))
			.optional(),
		id: z.string().max(225),
		label: boundedTextSchema.refine((value) => value.trim().length > 0),
		params: backdropParamsSchema,
		plugin: z.string().refine(isValidPluginId),
	})
	.catchall(z.json())
	.refine(
		(value) =>
			value.id.startsWith(`${value.plugin}:`) &&
			/^[a-z0-9][a-z0-9._-]{0,95}$/.test(
				value.id.slice(value.plugin.length + 1)
			)
	);
export const pluginBackgroundSchema = z.custom<PluginBackground>(
	(value) => pluginBackgroundInputSchema.safeParse(value).success
);
const backgroundRowsSchema = z.array(z.unknown());
const pluginJsonDocumentSchema = z.record(z.string(), z.json());
export type PluginJsonDocument = z.output<typeof pluginJsonDocumentSchema>;
export function isObjectRecord(
	value: Parameters<typeof pluginJsonDocumentSchema.parse>[0]
): value is PluginJsonDocument {
	return pluginJsonDocumentSchema.safeParse(value).success;
}
/** Parse untrusted contribution JSON once at the API or local-storage boundary. */
export function parsePluginBackgrounds(
	value: Parameters<typeof backgroundRowsSchema.parse>[0]
): PluginBackground[] {
	const rows = backgroundRowsSchema.safeParse(value);
	if (!rows.success) {
		return [];
	}
	const seen = new Set<string>();
	const backgrounds: PluginBackground[] = [];
	for (const entry of rows.data.slice(0, 256)) {
		const parsed = pluginBackgroundSchema.safeParse(entry);
		if (!parsed.success || seen.has(parsed.data.id)) {
			continue;
		}
		seen.add(parsed.data.id);
		backgrounds.push(parsed.data);
	}
	return backgrounds;
}
