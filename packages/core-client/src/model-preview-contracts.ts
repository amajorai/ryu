import { z } from "zod";
import { appJsonValueSchema } from "./app-request-json.ts";

// Full serde publishers: Core server/mod.rs model preview routes, the
// model-catalog crate's ModelDetail/UninstallPlan, and catalog_source DescriptorFile.
// A JSON u64 may round to 2**64 in JavaScript; retain that native boundary.
const nativeUnsigned = z
	.number()
	.refine(Number.isInteger)
	.nonnegative()
	.max(2 ** 64);
const modelFormat = z.enum(["gguf", "safetensors", "mlx"]);
const nullableText = z.string().nullable();
function nativeJsonView<S extends z.ZodType>(fields: S) {
	return z.custom<z.output<S>>(
		(value) =>
			appJsonValueSchema.safeParse(value).success &&
			fields.safeParse(value).success
	);
}
const card = z
	.looseObject({
		id: z.string(),
		author: z.string(),
		name: z.string(),
		downloads: nativeUnsigned,
		likes: nativeUnsigned,
		pipeline_tag: nullableText,
		tags: z.array(z.string()),
		gated: z.boolean(),
		last_modified: nullableText,
		created_at: nullableText,
		context_length: nativeUnsigned.nullable(),
		architecture: nullableText,
		params: nativeUnsigned.nullable(),
		installed: z.boolean(),
		format: modelFormat,
		compatible: z.boolean(),
		needs_engine: nullableText,
		diffusion: z.boolean(),
	})
	.catchall(appJsonValueSchema);
const file = z
	.looseObject({
		filename: z.string(),
		quant: nullableText,
		size_bytes: nativeUnsigned.nullable(),
		size_human: z.string(),
		sha256: nullableText,
		url: z.string(),
		installed: z.boolean(),
		fit: z.string(),
		fit_label: z.string(),
	})
	.catchall(appJsonValueSchema);
const stats = z
	.looseObject({
		matched_name: z.string(),
		intelligence_index: z.number().nullable(),
		output_tokens_per_second: z.number().nullable(),
		time_to_first_token_s: z.number().nullable(),
		price_usd_per_1m: z.number().nullable(),
	})
	.catchall(appJsonValueSchema);
const device = z
	.looseObject({
		total_ram_bytes: nativeUnsigned.nullable(),
		ram_human: z.string(),
		vram_bytes: nativeUnsigned.nullable(),
		vram_human: z.string(),
		gpu_name: nullableText,
		gpu_vendor: z.enum(["nvidia", "amd", "intel", "apple", "other"]).nullable(),
		unified_memory: z.boolean(),
		os: z.string(),
		// Additive: free space on the node's models volume. Older Cores omit it.
		disk_free_bytes: nativeUnsigned.nullable().optional(),
		disk_free_human: z.string().optional(),
	})
	.catchall(appJsonValueSchema);
const detail = z
	.looseObject({
		card,
		readme: nullableText,
		format: modelFormat,
		files: z.array(file),
		vision: z.boolean(),
		repo_size_bytes: nativeUnsigned.nullable(),
		repo_fit: z.string(),
		repo_fit_label: z.string(),
		stats: stats.nullable(),
		stats_api_key_present: z.boolean(),
		device,
	})
	.catchall(appJsonValueSchema);
const descriptorFile = z
	.looseObject({
		url: z.string(),
		sha256: nullableText,
		dest_filename: z.string(),
	})
	.catchall(appJsonValueSchema);
const installBase = {
	success: z.literal(true),
	dryRun: z.literal(true),
	action: z.literal("install"),
	writes: z.array(z.string()),
};
export const modelInstallPreviewSchema = nativeJsonView(
	z.union([
		z
			.looseObject({
				...installBase,
				source: z.string(),
				repoId: z.string(),
				files: z.array(descriptorFile),
			})
			.catchall(appJsonValueSchema),
		// The outer format echoes the caller's string; Core normalizes only detail.format.
		z
			.looseObject({
				...installBase,
				id: z.string(),
				file: z.string(),
				format: z.string(),
				detail,
			})
			.catchall(appJsonValueSchema),
	])
);
export const modelUninstallPreviewSchema = nativeJsonView(
	z
		.looseObject({
			success: z.literal(true),
			dryRun: z.literal(true),
			action: z.literal("uninstall"),
			plan: z
				.looseObject({
					repoId: z.string(),
					filename: z.string(),
					modelPath: z.string(),
					modelExists: z.boolean(),
					adapterPath: z.string(),
					adapterExists: z.boolean(),
				})
				.catchall(appJsonValueSchema),
			writes: z.array(z.string()),
		})
		.catchall(appJsonValueSchema)
);
const switchBase = {
	success: z.literal(true),
	dryRun: z.literal(true),
	action: z.literal("switch"),
	active: z.string(),
	engine: z.string(),
	format: modelFormat,
	current: nullableText,
	alreadyActive: z.boolean(),
	wouldPersist: z.literal(true),
	wouldRestart: z.boolean(),
	writes: z.array(z.string()),
};
export const activeModelPreviewSchema = nativeJsonView(
	z.union([
		z
			.looseObject({
				...switchBase,
				diffusion: z.literal(true),
				wouldRefreshGateway: z.literal(false),
			})
			.catchall(appJsonValueSchema),
		z
			.looseObject({
				...switchBase,
				residentEngine: nullableText,
				wouldSwap: z.boolean(),
				wouldRefreshGateway: z.literal(true),
			})
			.catchall(appJsonValueSchema),
	])
);
export type ModelInstallPreview = z.output<typeof modelInstallPreviewSchema>;
export type ModelUninstallPreview = z.output<
	typeof modelUninstallPreviewSchema
>;
export type ActiveModelPreview = z.output<typeof activeModelPreviewSchema>;

export type ModelPreviewDetail = z.output<typeof detail>;

export {
	card as modelCardFields,
	detail as modelDetailFields,
	device as modelDeviceFields,
	file as modelFileFields,
	stats as modelStatsFields,
};
