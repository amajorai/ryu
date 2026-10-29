import { wireObject } from "@ryuhq/protocol/wire-object";
import { z } from "zod";
import type { PackageRemixSource, PackageSource } from "./index.ts";
import { nativeJsonSchema } from "./native-json.ts";

const optionalString = z.string().or(z.undefined()).catch(undefined);
const optionalStrings = z.array(z.string()).or(z.undefined()).catch(undefined);
const objectContainer = z.custom<object>((value) => {
	const wrapped = new Object(value);
	return (
		wrapped === value &&
		!Array.isArray(value) &&
		!z.function().safeParse(value).success
	);
});
const stringDictionary = z.preprocess(
	(input) => {
		const container = objectContainer.safeParse(input);
		const result: Record<string, string> = {};
		if (container.success) {
			for (const [key, value] of Object.entries(container.data)) {
				const string = z.string().safeParse(value);
				if (key.trim() && string.success) {
					result[key] = string.data;
				}
			}
		}
		return result;
	},
	z.custom<Record<string, string>>((value) => {
		const container = objectContainer.safeParse(value);
		return (
			container.success &&
			Object.values(container.data).every(
				(item) => z.string().safeParse(item).success
			)
		);
	})
);
const jsonDictionary = z.custom<Record<string, z.core.util.JSONType>>(
	(value) => {
		const container = objectContainer.safeParse(value);
		return (
			container.success &&
			Object.values(container.data).every(
				(item) => nativeJsonSchema.safeParse(item).success
			)
		);
	}
);
const security = wireObject({
	containsSecrets: z.boolean().catch(false),
	permissions: optionalStrings.transform(
		(items) => items?.map((item) => item.trim()).filter(Boolean) ?? []
	),
	privateContent: z.boolean().catch(false),
	redacted: z.boolean().catch(false),
}).catch(() => ({
	containsSecrets: false,
	permissions: [],
	privateContent: false,
	redacted: false,
}));
const source = wireObject({
	type: z.enum(["github", "local", "archive"]),
	repository: optionalString,
	path: optionalString,
	ref: optionalString,
	commit: optionalString,
	checksum: optionalString,
})
	.transform((value) => {
		const result: PackageSource = { type: value.type };
		for (const key of [
			"repository",
			"path",
			"ref",
			"commit",
			"checksum",
		] as const) {
			const text = value[key]?.trim();
			if (text) {
				result[key] = text;
			}
		}
		return result;
	})
	.or(z.undefined())
	.catch(undefined);

const remixedFrom = wireObject({
	kind: optionalString,
	id: optionalString,
	version: optionalString,
})
	.transform((value) => {
		const kind = value.kind?.trim();
		const id = value.id?.trim();
		if (!(kind && id)) {
			return undefined;
		}
		const result: PackageRemixSource = { kind, id };
		const version = value.version?.trim();
		if (version) {
			result.version = version;
		}
		return result;
	})
	.or(z.undefined())
	.catch(undefined);

/** Decode every portable manifest field before applying ordered domain diagnostics. */
export const manifestFieldsSchema = wireObject({
	$schema: optionalString,
	schemaVersion: z.literal(1).or(z.undefined()).catch(undefined),
	kind: z
		.enum([
			"plugin",
			"app",
			"skill",
			"agent",
			"workflow",
			"theme",
			"output_style",
			"space",
			"profile",
			"bundle",
			"language_pack",
		])
		.or(z.undefined())
		.catch(undefined),
	id: optionalString,
	name: optionalString,
	version: optionalString,
	artifacts: optionalStrings,
	targets: optionalStrings,
	scopes: optionalStrings,
	capabilities: optionalStrings,
	includes: optionalStrings,
	requires: stringDictionary,
	security,
	source,
	allowRemix: z.boolean().or(z.undefined()).catch(undefined),
	allow_remix: z.boolean().or(z.undefined()).catch(undefined),
	remixedFrom,
	metadata: jsonDictionary.or(z.undefined()).catch(undefined),
});
export const packageScopeSchema = z.enum([
	"desktop",
	"node",
	"gateway",
	"agent",
	"space",
	"workflow",
]);
