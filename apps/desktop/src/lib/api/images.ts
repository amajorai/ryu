// apps/desktop/src/lib/api/images.ts
//
// Typed client for Core's image-generation and image-edit data path
// (`POST /api/images/generate`). Local text-to-image uses stable-diffusion.cpp's
// `/v1/images/generations`; local image edits use its img2img endpoint. Core
// normalizes both to `{ data: [{ b64_json }] }` for this client. Cloud images
// may also carry a `media_type`, which their `data:` URL keeps.
//
// Placement: this is a Core data-path call (it decides *what runs* — which local
// image engine generates), reached through the same node target as every other
// Core client module (see lib/api/voice.ts for the sibling speech path).

import type { RyuJsonValue } from "@ryu/app-host/rpc";
import { type ApiTarget, authenticatedFetch } from "./client.ts";
import {
	type ImageGenerationInput,
	imageDataUrl,
	imageGenerationErrorSchema,
	imageGenerationReplySchema,
	imageReaderResultSchema,
} from "./image-generation-contracts.ts";
import {
	buildImageResizePrompt,
	type ImageResizeAspect,
	type ImageResizeEngine,
	imageResizeSizeHint,
	resolveImageResizeRoute,
} from "./image-resize.ts";

const MAX_AI_RESIZE_INPUT_BYTES = 16 * 1024 * 1024;

export interface ImageResizeRequest {
	aspect: ImageResizeAspect;
	denoisingStrength: number;
	engine: ImageResizeEngine;
	height: number;
	image: Blob;
	instructions: string;
	mask?: Blob;
	signal: AbortSignal;
	width: number;
}

/** Options for {@link generateImage}. */
export interface GenerateImageOptions {
	/** Host attribution for app-level generation ACLs. */
	appId?: string;
	/** Human-facing app permission required for this host-direct call. */
	appPermission?: string;
	/** How many images to request (sd-server returns `data[]`). Defaults to 1. */
	count?: number;
	/** Local image-to-image denoising strength. */
	denoisingStrength?: number;
	/** Optional source images for an edit/remix request. */
	inputImages?: string[];
	/** Optional inpainting mask for local image-to-image generation. */
	inputMask?: string;
	/** Cloud model id (required when `provider` is set), e.g.
	 * `"black-forest-labs/flux-schnell"` (Replicate) or `"fal-ai/flux/dev"` (Fal). */
	model?: string;
	/**
	 * Cloud provider to route through the Gateway: `"openrouter"`, `"replicate"`,
	 * or `"fal"`. Omit (or use a local id) to render on the local
	 * stable-diffusion.cpp engine.
	 */
	provider?: string;
	/** Model-specific fields Core merges into a cloud provider body. Core
	 *  refuses routing keys, and refuses the field on the local engine. */
	providerInput?: Record<string, RyuJsonValue>;
	/** Correlates this generation with an app-owned Gateway audit request. */
	requestId?: string;
	/** Cancels a request when its owning editor closes. */
	signal?: AbortSignal;
	/** Optional size hint forwarded to the engine (e.g. "512x512"). */
	size?: string;
}

/**
 * Generate or edit an image via Core's `/api/images/generate`, returning
 * renderable URLs. Local generation returns base64 which we turn into `data:`
 * URLs; cloud providers may return hosted `url`s. Both are ready for an `<img>`.
 */
export async function generateImage(
	target: ApiTarget,
	prompt: string,
	options: GenerateImageOptions = {}
): Promise<string[]> {
	const body: ImageGenerationInput = {
		prompt,
		denoising_strength: options.denoisingStrength,
		n: options.count ?? 1,
		size: options.size,
		request_id: options.requestId,
	};
	if (options.provider) {
		body.provider = options.provider;
	}
	if (options.model) {
		body.model = options.model;
	}
	if (options.inputImages && options.inputImages.length > 0) {
		body.input_images = options.inputImages;
	}
	if (options.inputMask) {
		body.input_mask = options.inputMask;
	}
	if (options.providerInput !== undefined) {
		body.provider_input = options.providerInput;
	}

	const resp = await authenticatedFetch(target, "/api/images/generate", {
		method: "POST",
		headers:
			options.appId && options.appPermission
				? {
						"x-ryu-app-id": options.appId,
						"x-ryu-app-permission": options.appPermission,
					}
				: undefined,
		body: JSON.stringify(body),
		signal: options.signal,
	});

	if (!resp.ok) {
		let detail = `image generation failed: ${resp.status}`;
		try {
			const errorBody = imageGenerationErrorSchema.parse(await resp.json());
			if (errorBody.error) {
				detail = errorBody.error;
			}
		} catch {
			// Non-JSON error body — keep the status-based message.
		}
		throw new Error(detail);
	}

	const result = imageGenerationReplySchema.parse(await resp.json());
	const urls: string[] = [];
	for (const item of result.data ?? []) {
		if (item.url) {
			urls.push(item.url);
		} else if (item.b64_json) {
			urls.push(imageDataUrl(item.b64_json, item.media_type));
		}
	}
	return urls;
}

function imageBlobToDataUrl(image: Blob, signal: AbortSignal): Promise<string> {
	if (
		image.size < 1 ||
		image.size > MAX_AI_RESIZE_INPUT_BYTES ||
		!image.type.toLowerCase().startsWith("image/") ||
		image.type.toLowerCase() === "image/svg+xml"
	) {
		throw new Error("AI Resize needs a raster image under 16 MB.");
	}
	if (signal.aborted) {
		return Promise.reject(
			new DOMException("AI Resize cancelled.", "AbortError")
		);
	}

	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		const cleanup = () => signal.removeEventListener("abort", abortRead);
		const abortRead = () => reader.abort();
		reader.onload = () => {
			cleanup();
			const result = imageReaderResultSchema.safeParse(reader.result);
			if (result.success) {
				resolve(result.data);
			} else {
				reject(
					new Error("The browser could not prepare the image for AI Resize.")
				);
			}
		};
		reader.onerror = () => {
			cleanup();
			reject(
				reader.error ?? new Error("The browser could not read this image.")
			);
		};
		reader.onabort = () => {
			cleanup();
			reject(new DOMException("AI Resize cancelled.", "AbortError"));
		};
		signal.addEventListener("abort", abortRead, { once: true });
		if (signal.aborted) {
			cleanup();
			reject(new DOMException("AI Resize cancelled.", "AbortError"));
			return;
		}
		reader.readAsDataURL(image);
	});
}

/**
 * Run AI Resize through the selected engine. Local mode sends the source and
 * optional outpaint mask only to Core's local diffusion sidecar; Gateway mode
 * uses the image provider configured for the node.
 */
export async function generateImageResize(
	target: ApiTarget,
	request: ImageResizeRequest
): Promise<string> {
	let provider = "local";
	let model: string | undefined;
	if (request.engine === "gateway") {
		const { fetchGatewayConfig } = await import("./gateway.ts");
		const gateway = await fetchGatewayConfig(target, request.signal);
		const route = resolveImageResizeRoute(
			gateway.routing.modality_map?.image ?? {
				provider: gateway.routing.default_provider,
			}
		);
		provider = route.provider;
		model = route.model;
	}
	const imageUrl = await imageBlobToDataUrl(request.image, request.signal);
	const inputMask =
		request.engine === "local" && request.mask
			? await imageBlobToDataUrl(request.mask, request.signal)
			: undefined;
	const size =
		request.engine === "local"
			? `${request.width}x${request.height}`
			: imageResizeSizeHint(request.aspect, request.width, request.height);
	const options: GenerateImageOptions = {
		count: 1,
		inputImages: [imageUrl],
		provider,
		signal: request.signal,
		size,
	};
	if (inputMask) {
		options.inputMask = inputMask;
	}
	if (model) {
		options.model = model;
	}
	if (request.engine === "local") {
		options.denoisingStrength = request.denoisingStrength;
	}
	const urls = await generateImage(
		target,
		buildImageResizePrompt(
			request.aspect,
			request.width,
			request.height,
			request.instructions
		),
		options
	);
	const [result] = urls;
	if (!result) {
		throw new Error("The image provider returned no resized image.");
	}
	return result;
}
