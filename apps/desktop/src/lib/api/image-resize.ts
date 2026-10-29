import { isNativeObjectLike } from "@ryu/ui/lib/native-primitive-observation.ts";
import { z } from "zod";

const IMAGE_RESIZE_PROVIDERS = ["fal", "openrouter", "replicate"] as const;
const IMAGE_MODEL_DIMENSION_MULTIPLE = 8;
const LOCAL_DIFFUSION_DIMENSION_MULTIPLE = 64;
const MAX_AI_RESIZE_SIDE = 1536;
const MIN_AI_RESIZE_SIDE = 64;
const LOCAL_ASPECT_TOLERANCE = 0.01;

export const IMAGE_RESIZE_PRESETS = [
	{ id: "original", label: "Original", ratio: null, ratioLabel: null },
	{ id: "square", label: "Square", ratio: 1, ratioLabel: "1:1" },
	{ id: "landscape", label: "Landscape", ratio: 3 / 2, ratioLabel: "3:2" },
	{ id: "portrait", label: "Portrait", ratio: 2 / 3, ratioLabel: "2:3" },
	{ id: "widescreen", label: "Widescreen", ratio: 16 / 9, ratioLabel: "16:9" },
	{ id: "story", label: "Tall", ratio: 9 / 16, ratioLabel: "9:16" },
] as const;

export type ImageResizeAspect = (typeof IMAGE_RESIZE_PRESETS)[number]["id"];
export type ImageResizeEngine = "local" | "gateway";

export const DEFAULT_IMAGE_RESIZE_ENGINE: ImageResizeEngine = "local";

export interface ImageResizeDimensions {
	height: number;
	width: number;
}

function greatestCommonDivisor(left: number, right: number): number {
	let a = Math.max(1, Math.round(left));
	let b = Math.max(1, Math.round(right));
	while (b !== 0) {
		const remainder = a % b;
		a = b;
		b = remainder;
	}
	return a;
}

export function imageResizeAspectLabel(
	aspect: ImageResizeAspect,
	width: number,
	height: number
): string {
	imageResizeRatio(aspect, width, height);
	const preset = IMAGE_RESIZE_PRESETS.find(
		(candidate) => candidate.id === aspect
	);
	if (!preset) {
		throw new Error("Choose a supported AI resize shape.");
	}
	if (preset.ratioLabel) {
		return preset.ratioLabel;
	}
	const sourceWidth = Math.max(1, Math.round(width));
	const sourceHeight = Math.max(1, Math.round(height));
	const divisor = greatestCommonDivisor(sourceWidth, sourceHeight);
	return `${sourceWidth / divisor}:${sourceHeight / divisor}`;
}

export interface ImageResizeRoute {
	model?: string;
	provider: (typeof IMAGE_RESIZE_PROVIDERS)[number];
}

function isImageResizeProvider(
	provider: string
): provider is ImageResizeRoute["provider"] {
	return IMAGE_RESIZE_PROVIDERS.some((candidate) => candidate === provider);
}

const routeTextSchema = z.string();
/** Native synchronous scalar admission avoids formatting a ZodError, which
 * can inspect rejected opaque Proxy receivers. Only these primitive/callable
 * schemas are used; no object/union parser is run through this ABI. */
function routeScalarAdmits<S extends z.ZodString | z.ZodFunction>(
	schema: S,
	value: Parameters<typeof routeTextSchema._zod.run>[0]["value"]
): value is z.output<S> {
	const payload = { value, issues: [] };
	schema._zod.run(payload, { async: false });
	return payload.issues.length === 0;
}
/** Only native receiver representation is observed here. The provider/model
 * slots remain opaque until their original consuming reads; this is not a
 * complete Gateway configuration or a JSON transport contract. */
const routeReceiverSchema = z.custom<{
	provider?: Parameters<typeof routeTextSchema._zod.run>[0]["value"];
	model?: Parameters<typeof routeTextSchema._zod.run>[0]["value"];
}>(isNativeObjectLike);

function routeReceiverAdmits(
	value: Parameters<typeof routeReceiverSchema.safeParse>[0]
): value is z.output<typeof routeReceiverSchema> {
	const payload = { value, issues: [] };
	routeReceiverSchema._zod.run(payload, { async: false });
	return payload.issues.length === 0;
}

export function resolveImageResizeRoute(
	routeValue: Parameters<typeof routeReceiverSchema.safeParse>[0]
): ImageResizeRoute {
	const route = routeValue;
	if (
		!routeReceiverAdmits(route) ||
		Array.isArray(route) ||
		!("provider" in route) ||
		!routeScalarAdmits(routeTextSchema, route.provider)
	) {
		throw new Error(
			"AI Resize needs an image provider configured in Gateway routing."
		);
	}

	const provider = route.provider.trim().toLowerCase();
	if (!isImageResizeProvider(provider)) {
		throw new Error(
			"AI Resize supports the OpenRouter, Replicate, or fal image providers."
		);
	}

	const modelValue = "model" in route ? route.model : undefined;
	if (
		modelValue !== undefined &&
		modelValue !== null &&
		!routeScalarAdmits(routeTextSchema, modelValue)
	) {
		throw new Error("The configured image model id is invalid.");
	}
	const model = routeScalarAdmits(routeTextSchema, modelValue)
		? modelValue.trim()
		: "";
	return { provider, ...(model ? { model } : undefined) };
}

export function imageResizeDimensions(
	aspect: ImageResizeAspect,
	width: number,
	height: number
): ImageResizeDimensions {
	const ratio = imageResizeRatio(aspect, width, height);
	const targetWidth =
		ratio >= 1
			? MAX_AI_RESIZE_SIDE
			: Math.max(1, Math.round(MAX_AI_RESIZE_SIDE * ratio));
	const targetHeight =
		ratio >= 1
			? Math.max(1, Math.round(MAX_AI_RESIZE_SIDE / ratio))
			: MAX_AI_RESIZE_SIDE;
	const alignDimension = (dimension: number) =>
		Math.max(
			MIN_AI_RESIZE_SIDE,
			Math.round(dimension / IMAGE_MODEL_DIMENSION_MULTIPLE) *
				IMAGE_MODEL_DIMENSION_MULTIPLE
		);
	return {
		height: alignDimension(targetHeight),
		width: alignDimension(targetWidth),
	};
}

function imageResizeRatio(
	aspect: ImageResizeAspect,
	width: number,
	height: number
): number {
	if (
		!(
			Number.isFinite(width) &&
			Number.isFinite(height) &&
			width > 0 &&
			height > 0
		)
	) {
		throw new Error("AI Resize needs valid source image dimensions.");
	}
	const preset = IMAGE_RESIZE_PRESETS.find(
		(candidate) => candidate.id === aspect
	);
	if (!preset) {
		throw new Error("Choose a supported AI resize shape.");
	}
	return preset.ratio ?? width / height;
}

/**
 * Choose the largest local SDXL canvas whose dimensions are divisible by 64 and
 * whose aspect ratio is within one percent of the requested shape. The server
 * otherwise silently pads dimensions to its 64-pixel latent grid.
 */
export function localImageResizeDimensions(
	aspect: ImageResizeAspect,
	width: number,
	height: number,
	maxSide = MAX_AI_RESIZE_SIDE
): ImageResizeDimensions {
	const ratio = imageResizeRatio(aspect, width, height);
	if (
		!Number.isSafeInteger(maxSide) ||
		maxSide < LOCAL_DIFFUSION_DIMENSION_MULTIPLE ||
		maxSide > MAX_AI_RESIZE_SIDE ||
		maxSide % LOCAL_DIFFUSION_DIMENSION_MULTIPLE !== 0
	) {
		throw new Error(
			"Local AI Resize maximum side must be a 64-pixel multiple."
		);
	}

	let bestWithinTolerance: ImageResizeDimensions | undefined;
	let bestWithinToleranceArea = 0;
	let closest: ImageResizeDimensions | undefined;
	let closestAspectError = Number.POSITIVE_INFINITY;
	let closestArea = 0;
	for (
		let candidateWidth = LOCAL_DIFFUSION_DIMENSION_MULTIPLE;
		candidateWidth <= maxSide;
		candidateWidth += LOCAL_DIFFUSION_DIMENSION_MULTIPLE
	) {
		for (
			let candidateHeight = LOCAL_DIFFUSION_DIMENSION_MULTIPLE;
			candidateHeight <= maxSide;
			candidateHeight += LOCAL_DIFFUSION_DIMENSION_MULTIPLE
		) {
			const candidateRatio = candidateWidth / candidateHeight;
			const aspectError = Math.abs(candidateRatio - ratio) / ratio;
			const area = candidateWidth * candidateHeight;
			const candidate = { height: candidateHeight, width: candidateWidth };

			if (
				aspectError <= LOCAL_ASPECT_TOLERANCE &&
				area > bestWithinToleranceArea
			) {
				bestWithinTolerance = candidate;
				bestWithinToleranceArea = area;
			}
			if (
				aspectError < closestAspectError ||
				(Math.abs(aspectError - closestAspectError) < 1e-12 &&
					area > closestArea)
			) {
				closest = candidate;
				closestAspectError = aspectError;
				closestArea = area;
			}
		}
	}

	if (bestWithinTolerance) {
		return bestWithinTolerance;
	}
	if (closest) {
		return closest;
	}
	throw new Error("Could not choose a local AI Resize canvas.");
}

export function imageResizeDimensionsForEngine(
	engine: ImageResizeEngine,
	aspect: ImageResizeAspect,
	width: number,
	height: number
): ImageResizeDimensions {
	switch (engine) {
		case "local":
			return localImageResizeDimensions(aspect, width, height);
		case "gateway":
			return imageResizeDimensions(aspect, width, height);
		default: {
			const unreachableEngine: never = engine;
			return unreachableEngine;
		}
	}
}

export function imageResizeSizeHint(
	aspect: ImageResizeAspect,
	width: number,
	height: number
): string {
	const dimensions = imageResizeDimensions(aspect, width, height);
	return `${dimensions.width}x${dimensions.height}`;
}

export function buildImageResizePrompt(
	aspect: ImageResizeAspect,
	width: number,
	height: number,
	instructions: string
): string {
	const preset = IMAGE_RESIZE_PRESETS.find(
		(candidate) => candidate.id === aspect
	);
	if (!preset) {
		throw new Error("Choose a supported AI resize shape.");
	}
	const ratio = preset.ratio ?? width / height;
	const ratioLabel =
		preset.ratio === null
			? "the original aspect ratio"
			: `${ratio.toFixed(2)}:1`;
	const guidance = instructions.trim().slice(0, 280);
	return [
		`Generatively expand this image to ${preset.label.toLowerCase()} (${ratioLabel}).`,
		"Preserve the original subject, composition, colors, lighting, and style. Do not crop or stretch the source. Extend the scene naturally only into the added canvas area, matching its edges.",
		...(guidance ? [`Additional guidance: ${guidance}`] : []),
	].join(" ");
}
