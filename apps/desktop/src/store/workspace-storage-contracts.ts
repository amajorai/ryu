import {
	type DitherColor,
	isDitherColor,
} from "@ryu/ui/components/dither-kit/palette.ts";
import { parseGhostAvatar } from "@ryu/ui/components/ghost-avatar.ts";
import type { GlyphDitherValue } from "@ryu/ui/components/glyph.ts";
import { appRequestValueSchema } from "@ryuhq/core-client/app-request-json.ts";
import { z } from "zod";
import type {
	ProjectEnvironment,
	ProjectEnvironmentAction,
	ProjectEnvironmentScripts,
	ProjectEnvironmentVariable,
	ProjectIcon,
} from "./useWorkspaceStore.ts";

const ditherColorSchema = z.custom<DitherColor>(isDitherColor);
const ditherFieldsSchema = z.object({
	from: ditherColorSchema,
	to: ditherColorSchema.nullable().catch(null),
	direction: z.enum(["up", "down", "left", "right"]).catch("up"),
});
const normalizeDither = ditherFieldsSchema.optional().catch(undefined).parse;
const rawGlyphProjectionSchema = z.object({
	type: appRequestValueSchema.optional(),
	value: appRequestValueSchema.optional(),
	kind: appRequestValueSchema.optional(),
	emoji: appRequestValueSchema.optional(),
	dataUrl: appRequestValueSchema.optional(),
	id: appRequestValueSchema.optional(),
	color: appRequestValueSchema.optional(),
	style: appRequestValueSchema.optional(),
	seed: appRequestValueSchema.optional(),
	dither: appRequestValueSchema.optional(),
});

// Persisted project glyphs predate asGlyphValue's public input restrictions.
// Empty/long icon IDs, arbitrary string colors/DiceBear styles and long seeds
// remain valid here. Keep their original normalization rather than tightening
// the contract to the picker/catalog's current authoring limits.
export const projectIconStorageSchema = z
	.unknown()
	.transform((raw): ProjectIcon | null => {
		const parsed = rawGlyphProjectionSchema.safeParse(raw);
		if (!parsed.success) {
			return null;
		}
		const record = parsed.data;
		const legacy = z.string().safeParse(record.value);
		if (record.type === "emoji" && legacy.success) {
			return { kind: "emoji", emoji: legacy.data };
		}
		if (record.type === "image" && legacy.success) {
			return { kind: "avatar", dataUrl: legacy.data };
		}
		const dither: GlyphDitherValue | undefined = normalizeDither(record.dither);
		const emoji = z.string().safeParse(record.emoji);
		if (record.kind === "emoji" && emoji.success) {
			const result: Extract<ProjectIcon, { kind: "emoji" }> = {
				kind: "emoji",
				emoji: emoji.data,
			};
			if (dither) {
				result.dither = dither;
			}
			return result;
		}
		const avatar = z.string().safeParse(record.dataUrl);
		if (record.kind === "avatar" && avatar.success) {
			return { kind: "avatar", dataUrl: avatar.data };
		}
		const icon = z.string().safeParse(record.id);
		if (record.kind === "icon" && icon.success) {
			const color = z.string().safeParse(record.color);
			const result: Extract<ProjectIcon, { kind: "icon" }> = {
				kind: "icon",
				id: icon.data,
			};
			if (color.success) {
				result.color = color.data;
			}
			if (dither) {
				result.dither = dither;
			}
			return result;
		}
		const dicebear = z
			.object({ style: z.string(), seed: z.string() })
			.safeParse(record);
		if (record.kind === "dicebear" && dicebear.success) {
			return { kind: "dicebear", ...dicebear.data };
		}
		if (record.kind === "expressive") {
			const ghost = parseGhostAvatar(raw);
			return ghost ? { ...ghost, kind: "expressive" } : null;
		}
		if (record.kind === "dither" && dither) {
			return { kind: "dither", dither };
		}
		return null;
	});

const scriptsFieldsSchema = z.object({
	default: z.string(),
	linux: z.string(),
	macos: z.string(),
	windows: z.string(),
}) satisfies z.ZodType<ProjectEnvironmentScripts>;
const scriptsSchema = z.custom<ProjectEnvironmentScripts>(
	(value) => scriptsFieldsSchema.safeParse(value).success
);
const variableFieldsSchema = z.object({
	id: z.string(),
	key: z.string(),
	value: z.string(),
}) satisfies z.ZodType<ProjectEnvironmentVariable>;
const variableSchema = z.custom<ProjectEnvironmentVariable>(
	(value) => variableFieldsSchema.safeParse(value).success
);
const actionFieldsSchema = z.object({
	id: z.string(),
	name: z.string(),
	scripts: scriptsSchema,
}) satisfies z.ZodType<ProjectEnvironmentAction>;
const actionSchema = z.custom<ProjectEnvironmentAction>(
	(value) => actionFieldsSchema.safeParse(value).success
);
const environmentFieldsSchema = z.object({
	id: z.string(),
	name: z.string().trim().min(1),
	setup: scriptsSchema,
	cleanup: scriptsSchema,
	variables: appRequestValueSchema.optional(),
	actions: appRequestValueSchema.optional(),
});
const rawArraySchema = z.array(appRequestValueSchema);
export const projectEnvironmentsStorageSchema = rawArraySchema
	.transform((rows): ProjectEnvironment[] =>
		rows.flatMap((value) => {
			const parsed = environmentFieldsSchema.safeParse(value);
			if (!parsed.success) {
				return [];
			}
			const variables = rawArraySchema.safeParse(parsed.data.variables);
			const actions = rawArraySchema.safeParse(parsed.data.actions);
			return [
				{
					id: parsed.data.id,
					name: parsed.data.name,
					setup: parsed.data.setup,
					cleanup: parsed.data.cleanup,
					variables: variables.success
						? variables.data.flatMap((entry) => {
								const decoded = variableSchema.safeParse(entry);
								return decoded.success ? [decoded.data] : [];
							})
						: [],
					actions: actions.success
						? actions.data.flatMap((entry) => {
								const decoded = actionSchema.safeParse(entry);
								return decoded.success ? [decoded.data] : [];
							})
						: [],
				},
			];
		})
	)
	.catch([]);

// Legacy maps were also represented as arrays with numeric project keys.
// Validate every native JSON value, then return the original container so own
// __proto__ entries and additive nested metadata survive the stored projection.
const storageEntriesFieldsSchema = z.union([
	z.record(z.string(), appRequestValueSchema),
	rawArraySchema,
]);
export const workspaceStorageEntriesSchema = z.custom<
	z.output<typeof storageEntriesFieldsSchema>
>(
	(value) =>
		appRequestValueSchema.safeParse(value).success &&
		storageEntriesFieldsSchema.safeParse(value).success
);
export const workspaceFoldersStorageSchema = rawArraySchema
	.transform((values) =>
		values.flatMap((value) => {
			const parsed = z.string().safeParse(value);
			return parsed.success ? [parsed.data] : [];
		})
	)
	.catch([]);
export const workspaceRetainedFolderEntriesSchema = rawArraySchema
	.transform((values) =>
		values.filter((value) => !z.string().safeParse(value).success)
	)
	.catch([]);
export const workspaceNameStorageSchema = z.string().trim().min(1);
export const workspaceActiveEnvironmentStorageSchema = z.string();
