// Response codecs for lifecycle capabilities, catalog entries, sources,
// versions and sidecar previews that `plugins.ts` reads. Split out of
// `plugins.ts`; the public client API stays there.

import {
	appJsonValueSchema,
	appResponseValueSchema,
} from "@ryuhq/core-client/app-request-json";
import { z } from "zod";
import { gatewayJsonValueSchema } from "@/src/lib/api/gateway-json-contracts.ts";

export const APP_LIFECYCLE_PERMISSIONS = [
	"app.install",
	"app.update",
	"app.enable",
	"app.disable",
	"app.uninstall",
] as const;

// Response codecs validate the consumed native DTO fields and retain JSON extension fields.
export const appLifecycleCapabilitiesResponseCodec = z
	.object({
		node: z.union([
			z
				.object({
					id: z.string(),
					orgId: z.union([z.string(), z.null()]),
					ownerUserId: z.union([z.string(), z.null()]),
					scope: z.union([
						z.literal("org"),
						z.literal("team"),
						z.literal("personal"),
					]),
					teamId: z.union([z.string(), z.null()]),
				})
				.catchall(gatewayJsonValueSchema),
			z.null(),
		]),
		permissions: z.record(z.enum(APP_LIFECYCLE_PERMISSIONS), z.boolean()),
		reasons: z
			.partialRecord(z.enum(APP_LIFECYCLE_PERMISSIONS), z.string())
			.optional(),
	})
	.catchall(gatewayJsonValueSchema);

const catalogBannerGradientResponseCodec = z
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
	.catchall(gatewayJsonValueSchema);

const catalogBannerResponseCodec = z
	.object({
		background: z.string().optional(),
		colors: z.array(z.string()).optional(),
		gradient: catalogBannerGradientResponseCodec.optional(),
		imageUrl: z.string().optional(),
		noise: z
			.object({ opacity: z.number().optional(), scale: z.number().optional() })
			.catchall(gatewayJsonValueSchema)
			.optional(),
		seed: z.number().optional(),
		style: z
			.union([
				z.literal("gradient"),
				z.literal("animated-gradient"),
				z.literal("dither"),
				z.literal("flat"),
				z.literal("image"),
			])
			.optional(),
	})
	.catchall(gatewayJsonValueSchema);

const cardDitherResponseCodec = z
	.object({
		direction: z.union([z.string(), z.null()]).optional(),
		from: z.union([z.string(), z.number(), z.null()]).optional(),
		to: z.union([z.string(), z.number(), z.null()]).optional(),
	})
	.catchall(gatewayJsonValueSchema);

const catalogLayerResponseCodec = z
	.object({
		capability: z.string(),
		selectable: z.boolean().optional(),
		target: z.union([z.string(), z.null()]).optional(),
		title: z.union([z.string(), z.null()]).optional(),
		toolkit: z.boolean().optional(),
		verbs: z.array(z.string()).optional(),
	})
	.catchall(gatewayJsonValueSchema);

const catalogSurfaceSupportResponseCodec = z
	.object({
		inheritedFrom: z.union([z.string(), z.null()]).optional(),
		support: z.union([z.string(), z.null()]).optional(),
		surface: z.string(),
	})
	.catchall(gatewayJsonValueSchema);

const cardThemePreviewResponseCodec = z
	.object({
		bg: z.string(),
		mode: z.union([z.string(), z.null()]).optional(),
		primary: z.string(),
		surface: z.string(),
		text: z.string(),
	})
	.catchall(gatewayJsonValueSchema);

const catalogEntryResponseCodec = z
	.object({
		accent_color: z.union([z.string(), z.null()]).optional(),
		author: z.union([z.string(), z.null()]).optional(),
		banner: z.union([catalogBannerResponseCodec, z.null()]).optional(),
		built_in: z.boolean(),
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
		github_source: z
			.union([z.record(z.string(), appJsonValueSchema), z.null()])
			.optional(),
		homepage: z.union([z.string(), z.null()]).optional(),
		icon: z.union([z.string(), z.null()]).optional(),
		icon_background: z.union([z.string(), z.null()]).optional(),
		icon_dither: z.union([cardDitherResponseCodec, z.null()]).optional(),
		icon_url: z.union([z.string(), z.null()]).optional(),
		id: z.string(),
		integration_kind: z.union([z.string(), z.null()]).optional(),
		integration_url: z.union([z.string(), z.null()]).optional(),
		keywords: z.array(z.string()).optional(),
		kinds: z.array(z.string()),
		layers: z.array(catalogLayerResponseCodec).optional(),
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
					.catchall(gatewayJsonValueSchema),
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
									.catchall(gatewayJsonValueSchema)
							)
							.optional(),
						grants: z.array(z.string()).optional(),
					})
					.catchall(gatewayJsonValueSchema),
				z.null(),
			])
			.optional(),
		reviewed: z.boolean().optional(),
		runnables: z
			.array(
				z
					.object({
						id: z.string(),
						kind: z.string(),
						name: z.string().optional(),
					})
					.catchall(gatewayJsonValueSchema)
			)
			.optional(),
		screenshots: z.array(z.string()).optional(),
		source: z.string(),
		stars: z.union([z.number(), z.null()]).optional(),
		surface_support: z.array(catalogSurfaceSupportResponseCodec).optional(),
		tagline: z.union([z.string(), z.null()]).optional(),
		tags: z.array(z.string()),
		terms_of_service_url: z.union([z.string(), z.null()]).optional(),
		theme_preview: z
			.union([cardThemePreviewResponseCodec, z.null()])
			.optional(),
		type: z.union([z.literal("app"), z.literal("plugin")]).optional(),
		version: z.string(),
		website: z.union([z.string(), z.null()]).optional(),
	})
	.catchall(gatewayJsonValueSchema);

export const responseCodec1 = z
	.object({ entries: z.array(catalogEntryResponseCodec).optional() })
	.catchall(gatewayJsonValueSchema);

const sourceWireResponseCodec = z
	.object({
		base_url: z.union([z.string(), z.null()]).optional(),
		builtin: z.boolean().optional(),
		display_name: z.string(),
		id: z.string(),
	})
	.catchall(gatewayJsonValueSchema);

export const responseCodec2 = z
	.object({
		active: z.string().optional(),
		sources: z.array(sourceWireResponseCodec).optional(),
	})
	.catchall(gatewayJsonValueSchema);

export const responseCodec3 = z
	.object({ ok: z.boolean().optional(), error: z.string().optional() })
	.catchall(gatewayJsonValueSchema);

export const versionSnapshotResponseCodec = z
	.object({
		atRef: z.union([z.string(), z.null()]).optional(),
		description: z.union([z.string(), z.null()]).optional(),
		engines: z
			.union([
				z
					.object({ ryu: z.union([z.string(), z.null()]).optional() })
					.catchall(gatewayJsonValueSchema),
				z.null(),
			])
			.optional(),
		license: z.union([z.string(), z.null()]).optional(),
		permissions: gatewayJsonValueSchema.optional(),
		readme: z.union([z.string(), z.null()]).optional(),
		readmeUrl: z.union([z.string(), z.null()]).optional(),
		stability: z.union([z.string(), z.null()]).optional(),
		stabilityKnown: z.boolean().optional(),
		surfaceSupport: z
			.union([z.array(catalogSurfaceSupportResponseCodec), z.null()])
			.optional(),
		surfaces: z.union([z.array(z.string()), z.null()]).optional(),
		targets: z.union([z.array(z.string()), z.null()]).optional(),
		version: z.union([z.string(), z.null()]).optional(),
	})
	.catchall(gatewayJsonValueSchema);

const catalogChannelResponseCodec = z
	.object({
		channel: z.string(),
		installable: z.boolean().optional(),
		version: z.union([z.string(), z.null()]).optional(),
	})
	.catchall(gatewayJsonValueSchema);

export const responseCodec4 = z
	.object({ channels: z.array(catalogChannelResponseCodec).optional() })
	.catchall(gatewayJsonValueSchema);

export const sidecarLifecyclePreviewResponseCodec = z
	.object({
		action: z.union([z.literal("install"), z.literal("uninstall")]),
		dryRun: z.literal(true),
		name: z.string(),
		success: z.boolean(),
	})
	.catchall(appResponseValueSchema);
