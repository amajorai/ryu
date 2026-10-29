// Response schemas for the plugin host bridge, catalog browse/detail and
// sidecar endpoints that `plugins.ts` reads. Split out of `plugins.ts`; the
// public client API stays there.

import type {
	DesignSystemFile,
	DesignSystemNavigation,
} from "@ryu/marketplace/catalog/scorecard";
import type {
	CardThemePreview,
	CatalogBanner,
	CatalogBannerGradient,
	CatalogExtensionSummary,
	CatalogImplementationSummary,
	DesignSystemEvidence,
} from "@ryu/marketplace/catalog/types";
import { z } from "zod";
import {
	pluginDocumentSchema,
	pluginValueSchema,
} from "./plugin-wire-values.ts";
import type {
	CatalogEntry,
	PluginCatalogDetail,
	PluginHostErrorCode,
} from "./plugins.ts";
import {
	cardDitherResponseSchema,
	catalogLayerResponseSchema,
	catalogSurfaceSupportResponseSchema,
} from "./plugins-app-response-contracts.ts";

export const hostArgumentsSchema = pluginValueSchema.optional();

export const hostErrorCodeSchema = z.enum([
	"denied",
	"not_found",
	"over_budget",
	"server_error",
	"invalid_args",
]) satisfies z.ZodType<PluginHostErrorCode>;

export const hostResponseSchema = z
	.object({ result: pluginValueSchema.optional() })
	.catchall(pluginValueSchema);

export const uiBundleSchema = z
	.object({ code: z.string().optional() })
	.catchall(pluginValueSchema);

export const hostStreamFrameSchema = z
	.object({
		type: z.string().optional().catch(undefined),
		delta: z.string().optional().catch(undefined),
		errorText: z.string().optional().catch(undefined),
	})
	.catchall(pluginValueSchema);

const catalogBannerGradientResponseSchema = z
	.object({
		color1: z.string().optional(),
		color2: z.string().optional(),
		color3: z.string().optional(),
		distortion: z.number().optional(),
		offset: z.number().optional(),
		preset: z.string().optional(),
		proportion: z.number().optional(),
		rotation: z.number().optional(),
		scale: z.number().optional(),
		shape: z.string().optional(),
		shapeSize: z.number().optional(),
		softness: z.number().optional(),
		speed: z.number().optional(),
		swirl: z.number().optional(),
		swirlIterations: z.number().optional(),
	})
	.catchall(pluginValueSchema) satisfies z.ZodType<CatalogBannerGradient>;

const catalogBannerResponseSchema = z
	.object({
		background: z.string().optional(),
		colors: z.array(z.string()).optional(),
		gradient: catalogBannerGradientResponseSchema.optional(),
		imageUrl: z.string().optional(),
		noise: z
			.object({ opacity: z.number().optional(), scale: z.number().optional() })
			.catchall(pluginValueSchema)
			.optional(),
		seed: z.number().optional(),
		style: z
			.enum(["gradient", "animated-gradient", "dither", "flat", "image"])
			.optional(),
	})
	.catchall(pluginValueSchema) satisfies z.ZodType<CatalogBanner>;

const cardThemePreviewResponseSchema = z
	.object({
		bg: z.string(),
		mode: z.union([z.string(), z.null()]).optional(),
		primary: z.string(),
		surface: z.string(),
		text: z.string(),
	})
	.catchall(pluginValueSchema) satisfies z.ZodType<CardThemePreview>;

const catalogEntryResponseSchema = z
	.object({
		accent_color: z.union([z.string(), z.null()]).optional(),
		author: z.union([z.string(), z.null()]).optional(),
		banner: z.union([catalogBannerResponseSchema, z.null()]).optional(),
		built_in: z.boolean(),
		catalog_source_id: z.string().optional().catch(undefined),
		bundles: z.union([z.array(z.string()), z.null()]).optional(),
		capabilities: z.array(z.string()).optional(),
		category: z.union([z.string(), z.null()]).optional(),
		description: z.string(),
		descriptor_only: z.boolean().optional(),
		developer: z.union([z.string(), z.null()]).optional(),
		download_url: z.union([z.string(), z.null()]).optional(),
		downloads: z.union([z.number(), z.null()]).optional(),
		example_prompts: z.array(z.string()).optional(),
		external: z.boolean().optional(),
		github_source: z.union([pluginDocumentSchema, z.null()]).optional(),
		homepage: z.union([z.string(), z.null()]).optional(),
		icon: z.union([z.string(), z.null()]).optional(),
		icon_background: z.union([z.string(), z.null()]).optional(),
		icon_dither: z.union([cardDitherResponseSchema, z.null()]).optional(),
		icon_url: z.union([z.string(), z.null()]).optional(),
		id: z.string(),
		integration_kind: z.union([z.string(), z.null()]).optional(),
		integration_url: z.union([z.string(), z.null()]).optional(),
		keywords: z.array(z.string()).optional(),
		kinds: z.array(z.string()),
		layers: z.array(catalogLayerResponseSchema).optional(),
		license: z.union([z.string(), z.null()]).optional(),
		membership_included: z.boolean().optional(),
		name: z.string(),
		origin: z
			.union([z.literal("community"), z.literal("first_party"), z.null()])
			.optional(),
		package_checksum: z.union([z.string(), z.null()]).optional(),
		package_kind: z.union([z.string(), z.null()]).optional(),
		permission_grants: z.array(z.string()),
		pricing: z
			.union([
				z
					.object({
						amountMinor: z.number().optional(),
						currency: z.string().optional(),
						kind: z.string().optional(),
					})
					.catchall(pluginValueSchema),
				z.null(),
			])
			.optional(),
		privacy_policy_url: z.union([z.string(), z.null()]).optional(),
		provenance: z.union([z.string(), z.null()]).optional(),
		rating_average: z.union([z.number(), z.null()]).optional(),
		rating_count: z.union([z.number(), z.null()]).optional(),
		repo_url: z.union([z.string(), z.null()]).optional(),
		repository_url: z.union([z.string(), z.null()]).optional(),
		requires: z
			.union([
				z
					.object({
						apps: z
							.array(
								z
									.object({
										id: z.string(),
										min_version: z.union([z.string(), z.null()]).optional(),
									})
									.catchall(pluginValueSchema)
							)
							.optional(),
						grants: z.array(z.string()).optional(),
					})
					.catchall(pluginValueSchema),
				z.null(),
			])
			.optional(),
		org_verified: z.boolean().optional().catch(undefined),
		org_verified_tier: z
			.union([z.string(), z.null()])
			.optional()
			.catch(undefined),
		publisher_trust: z
			.union([
				z.literal("gold"),
				z.literal("blue"),
				z.literal("dotted"),
				z.null(),
			])
			.optional()
			.catch(undefined),
		reviewed: z.boolean().optional(),
		runnables: z
			.array(
				z
					.object({
						id: z.string(),
						kind: z.string(),
						name: z.string().optional(),
					})
					.catchall(pluginValueSchema)
			)
			.optional(),
		screenshots: z.array(z.string()).optional(),
		source: z.string(),
		stars: z.union([z.number(), z.null()]).optional(),
		surface_support: z.array(catalogSurfaceSupportResponseSchema).optional(),
		tagline: z.union([z.string(), z.null()]).optional(),
		tags: z.array(z.string()),
		terms_of_service_url: z.union([z.string(), z.null()]).optional(),
		theme_preview: z
			.union([cardThemePreviewResponseSchema, z.null()])
			.optional(),
		type: z.enum(["app", "plugin"]).optional(),
		version: z.string(),
		website: z.union([z.string(), z.null()]).optional(),
	})
	.catchall(pluginValueSchema) satisfies z.ZodType<CatalogEntry>;

const designSystemFileResponseSchema = z
	.object({
		contents: z.union([z.string(), z.null()]).optional(),
		path: z.string(),
	})
	.catchall(pluginValueSchema) satisfies z.ZodType<DesignSystemFile>;

const designSystemNavigationResponseSchema = z.enum([
	"local",
	"manifest",
	"unknown",
]) satisfies z.ZodType<DesignSystemNavigation>;

const designSystemEvidenceResponseSchema = z
	.object({
		files: z
			.union([z.array(designSystemFileResponseSchema), z.null()])
			.optional(),
		navigation: z
			.union([designSystemNavigationResponseSchema, z.null()])
			.optional(),
	})
	.catchall(pluginValueSchema) satisfies z.ZodType<DesignSystemEvidence>;

const catalogExtensionSummaryResponseSchema = z
	.object({
		features: z.array(z.string()),
		label: z.string(),
		target: z.string(),
	})
	.catchall(pluginValueSchema) satisfies z.ZodType<CatalogExtensionSummary>;

const catalogImplementationSummaryResponseSchema = z
	.object({
		features: z.array(z.string()),
		label: z.string(),
		layer: z.string(),
	})
	.catchall(
		pluginValueSchema
	) satisfies z.ZodType<CatalogImplementationSummary>;

const pluginCatalogDetailResponseSchema = z
	.object({
		accentColor: z.union([z.string(), z.null()]).optional(),
		author: z.union([z.string(), z.null()]).optional(),
		banner: z.union([catalogBannerResponseSchema, z.null()]).optional(),
		capabilities: z.array(z.string()).optional(),
		categories: z.array(z.string()).optional(),
		category: z.union([z.string(), z.null()]).optional(),
		description: z.union([z.string(), z.null()]).optional(),
		descriptor: z
			.object({
				integration_kind: z.string().optional(),
				kind: z.string().optional(),
				url: z.union([z.string(), z.null()]).optional(),
				domain: z.union([z.string(), z.null()]).optional(),
			})
			.catchall(pluginValueSchema)
			.optional(),
		designSystem: z
			.union([designSystemEvidenceResponseSchema, z.null()])
			.optional(),
		domain: z.union([z.string(), z.null()]).optional(),
		downloads: z.union([z.number(), z.null()]).optional(),
		examplePrompts: z.array(z.string()).optional(),
		extensions: z.array(catalogExtensionSummaryResponseSchema).optional(),
		external: z.boolean().optional(),
		feeds: z.array(z.string()).optional(),
		iconBackground: z.union([z.string(), z.null()]).optional(),
		iconUrl: z.union([z.string(), z.null()]).optional(),
		id: z.string(),
		implementation: z
			.array(catalogImplementationSummaryResponseSchema)
			.optional(),
		integration_kind: z.union([z.string(), z.null()]).optional(),
		keywords: z.array(z.string()).optional(),
		kind: z.union([z.string(), z.null()]).optional(),
		layers: z.array(catalogLayerResponseSchema).optional(),
		license: z.union([z.string(), z.null()]).optional(),
		name: z.string().optional(),
		privacyPolicyUrl: z.union([z.string(), z.null()]).optional(),
		repositoryUrl: z.union([z.string(), z.null()]).optional(),
		screenshots: z.array(z.string()).optional(),
		source: z.string().optional(),
		sourceUrl: z.union([z.string(), z.null()]).optional(),
		surfaceSupport: z.array(catalogSurfaceSupportResponseSchema).optional(),
		tagline: z.union([z.string(), z.null()]).optional(),
		tags: z.array(z.string()).optional(),
		termsOfServiceUrl: z.union([z.string(), z.null()]).optional(),
		updatedAt: z.union([z.string(), z.null()]).optional(),
		url: z.union([z.string(), z.null()]).optional(),
		version: z.union([z.string(), z.null()]).optional(),
		website: z.union([z.string(), z.null()]).optional(),
	})
	.catchall(pluginValueSchema) satisfies z.ZodType<PluginCatalogDetail>;

export const sidecarsEnvelopeSchema = z
	.object({
		sidecars: z
			.array(
				z
					.object({
						name: z.string(),
						running: z.boolean(),
						pid: z.number().optional(),
						memory_bytes: z.number().optional(),
						cpu_percent: z.number().optional(),
						sandbox: z
							.object({
								mode: z.enum(["off", "audit", "enforce"]),
								backend: z.string(),
								enforced: z.boolean(),
								fs_restricted: z.boolean(),
								detail: z.string().optional(),
							})
							.catchall(pluginValueSchema)
							.optional(),
					})
					.catchall(pluginValueSchema)
			)
			.optional(),
	})
	.catchall(pluginValueSchema);

export const engineConcurrencyWireSchema = z
	.object({
		admission: z
			.object({
				gates: z
					.array(
						z
							.object({
								in_flight: z.number(),
								max_in_flight: z.number(),
								queued: z.number(),
								queued_interactive: z.number(),
							})
							.catchall(pluginValueSchema)
					)
					.optional(),
			})
			.catchall(pluginValueSchema)
			.optional(),
		engine_busy_slots: z.number().nullable().optional(),
		engine_total_slots: z.number().nullable().optional(),
	})
	.catchall(pluginValueSchema);

export const catalogBrowseSchema = z
	.object({
		app_total: z.number().nullable().optional(),
		entries: z.array(catalogEntryResponseSchema).optional(),
		next_cursor: z.string().nullable().optional(),
		note: z.string().nullable().optional(),
		plugin_total: z.number().nullable().optional(),
		total: z.number().nullable().optional(),
		total_count: z.number().nullable().optional(),
	})
	.catchall(pluginValueSchema);

export const catalogDetailWireSchema = pluginCatalogDetailResponseSchema
	.omit({ author: true })
	.extend({ author: pluginValueSchema.optional() });

export const nativeErrorStatusSchema = z.object({
	status: z.number().optional(),
});
