// apps/desktop/src/lib/api/images.ts
//
// Typed client for Core's image-generation data path (`POST /api/images/generate`).
// Core proxies the prompt to the stable-diffusion.cpp media sidecar's OpenAI-style
// `/v1/images/generations` and returns `{ data: [{ b64_json }] }`. We surface the
// first image as a `data:image/png;base64,…` URL the message list can render inline.
//
// Placement: this is a Core data-path call (it decides *what runs* — which local
// image engine generates), reached through the same node target as every other
// Core client module (see lib/api/voice.ts for the sibling speech path).

import { type ApiTarget, apiUrl, makeHeaders } from "./client.ts";

/** Options for {@link generateImage}. */
export interface GenerateImageOptions {
	/** How many images to request (sd-server returns `data[]`). Defaults to 1. */
	count?: number;
	/** Cloud model id (required when `provider` is set), e.g.
	 * `"black-forest-labs/flux-schnell"` (Replicate) or `"fal-ai/flux/dev"` (Fal). */
	model?: string;
	/**
	 * Cloud provider to route through the Gateway: `"openrouter"`, `"replicate"`,
	 * or `"fal"`. Omit (or use a local id) to render on the local
	 * stable-diffusion.cpp engine.
	 */
	provider?: string;
	/** Optional size hint forwarded to the engine (e.g. "512x512"). */
	size?: string;
}

/**
 * Generate an image from a text prompt via Core's `/api/images/generate`,
 * returning a list of renderable URLs. Local generation returns base64 which we
 * turn into `data:` URLs; cloud providers return hosted `url`s. Both are ready to
 * drop into an `<img src>`.
 */
export async function generateImage(
	target: ApiTarget,
	prompt: string,
	options: GenerateImageOptions = {}
): Promise<string[]> {
	const body: Record<string, unknown> = {
		prompt,
		n: options.count ?? 1,
		size: options.size,
	};
	if (options.provider) {
		body.provider = options.provider;
	}
	if (options.model) {
		body.model = options.model;
	}

	const resp = await fetch(apiUrl(target, "/api/images/generate"), {
		method: "POST",
		headers: makeHeaders(target.token),
		body: JSON.stringify(body),
	});

	if (!resp.ok) {
		let detail = `image generation failed: ${resp.status}`;
		try {
			const errorBody = (await resp.json()) as { error?: string };
			if (errorBody.error) {
				detail = errorBody.error;
			}
		} catch {
			// Non-JSON error body — keep the status-based message.
		}
		throw new Error(detail);
	}

	const result = (await resp.json()) as {
		data?: { b64_json?: string; url?: string }[];
	};
	const urls: string[] = [];
	for (const item of result.data ?? []) {
		if (item.url) {
			urls.push(item.url);
		} else if (item.b64_json) {
			urls.push(`data:image/png;base64,${item.b64_json}`);
		}
	}
	return urls;
}
