import { z } from "zod";

/** JSON-safe Marketplace wallpaper choice shared across Ryu surfaces. */
export interface MarketplaceWallpaperSelection {
	backdropId: string;
	id: string;
	params: Record<string, JsonValue>;
}

export type JsonValue =
	| boolean
	| null
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue };

const MAX_SELECTION_JSON_LENGTH = 16_384;
const MAX_PARAM_DEPTH = 5;
const PARAM_KEY_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const BACKDROP_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;

/** True for a namespaced `<plugin>:<local-id>` Marketplace contribution id. */
export function isMarketplaceId(value: string): boolean {
	if (value.length > 225) {
		return false;
	}
	const separator = value.lastIndexOf(":");
	if (separator <= 0) {
		return false;
	}
	const plugin = value.slice(0, separator);
	const localId = value.slice(separator + 1);
	const validPlugin = plugin.startsWith("@")
		? /^@[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(plugin)
		: /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(plugin);
	return (
		validPlugin &&
		/^[a-z0-9][a-z0-9._-]{0,95}$/.test(localId) &&
		value === `${plugin}:${localId}`
	);
}

// A JSON container may come from a class instance or a null-prototype object.
// Decode its own enumerable entries, just as the original wire projection did.
const objectInput = z.custom<object>(
	(value) =>
		// oxlint-disable-next-line anti-slop/no-runtime-typeof -- This shallow admission predicate prevents recursive decoding of untrusted children.
		typeof value === "object" && value !== null && !Array.isArray(value)
);
const paramKey = z
	.string()
	.regex(PARAM_KEY_RE)
	.refine((key) => !["__proto__", "constructor", "prototype"].includes(key));
const primitive = z.union([
	z.null(),
	z.boolean(),
	z.number().finite(),
	z.string().max(4096),
]);

function jsonObject(depth: number): z.ZodType<Record<string, JsonValue>> {
	return objectInput
		.refine((value) => Object.keys(value).length <= 64)
		.pipe(objectInput)
		.refine((value) =>
			Object.keys(value).every((key) => paramKey.safeParse(key).success)
		)
		.transform((value) => Object.fromEntries(Object.entries(value)))
		.pipe(
			z
				.record(paramKey, jsonValue(depth + 1))
				.refine((value) => Object.keys(value).length <= 64)
		);
}

function jsonValue(depth: number): z.ZodType<JsonValue> {
	if (depth >= MAX_PARAM_DEPTH) {
		return primitive;
	}
	return z.union([
		primitive,
		z
			.custom<unknown[]>((value) => Array.isArray(value) && value.length <= 128)
			.pipe(z.array(jsonValue(depth + 1))),
		jsonObject(depth),
	]);
}

export const marketplaceWallpaperSelectionSchema = z
	.object({
		backdropId: z.string().regex(BACKDROP_ID_RE),
		id: z.string().refine(isMarketplaceId),
		params: jsonObject(0),
	})
	.pipe(
		z.custom<MarketplaceWallpaperSelection>(
			(value) => JSON.stringify(value).length <= MAX_SELECTION_JSON_LENGTH
		)
	);

/** Parse and bound the value at an API, storage, or browser rendering boundary. */
export const parseMarketplaceWallpaperSelection =
	marketplaceWallpaperSelectionSchema.optional().catch(undefined).parse;
