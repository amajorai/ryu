import type { HostServices } from "@ryu/app-host/rpc";
import { z } from "zod";
import { generateAudio } from "../../lib/api/audio.ts";
import type { ApiTarget } from "../../lib/api/client.ts";
import { generateImage } from "../../lib/api/images.ts";
import { pluginHostInvoke } from "../../lib/api/plugins.ts";
import { generateVideo } from "../../lib/api/video.ts";

/** What the Companion host needs to reach Core's generation routes for one app. */
export interface CompanionMediaContext {
	/** App attribution sent with a host-direct media call, when the app has a
	 *  human-facing generation permission of its own. */
	appId?: string;
	appPermission?: string;
	/** Turn a provider URL into a `data:` URL the CSP-locked frame can render. */
	inline: (url: string) => Promise<string>;
	/** The owning plugin id, which keys the governed host bridge. */
	pluginId: string;
	/** Cloud job poll cadence in ms; the API clients default to 3000. */
	pollIntervalMs?: number;
	target: ApiTarget;
}

/** The `type` of a `data:` URI, used once a remote file has been inlined so the
 *  reported MIME matches the bytes the frame actually receives. */
function inlinedMediaType(url: string, declared: string): string {
	const match = /^data:([a-z]+\/[a-z0-9.+-]+)[;,]/iu.exec(url);
	return match?.[1] ?? declared;
}

/**
 * The Companion host's generation services: image, video and audio generation
 * plus `model.complete`. Each forwards the already-validated bridge fields to
 * Core unchanged (reference frames, source clip, audio track, `provider_input`,
 * vision images). Core maps them for the selected target or refuses with a
 * reason, which reaches the app as the call's error.
 */
export function createCompanionMediaServices(
	context: CompanionMediaContext
): Pick<
	HostServices,
	| "bridgeFeatures"
	| "generateAudio"
	| "generateImage"
	| "generateVideo"
	| "modelComplete"
> {
	const { appId, appPermission, inline, pluginId, pollIntervalMs, target } =
		context;
	return {
		bridgeFeatures: ["media.video.inputs", "model.vision"],
		modelComplete: (input) =>
			pluginHostInvoke(target, pluginId, "model.complete", input).then(
				z.string().parse
			),
		generateImage: async (input) => {
			const urls = await generateImage(target, input.prompt, {
				appId,
				appPermission,
				count: input.count,
				size: input.size,
				provider: input.provider,
				model: input.model,
				requestId: input.request_id,
				inputImages: input.input_images,
				providerInput: input.provider_input,
			});
			return await Promise.all(urls.map(inline));
		},
		generateVideo: async (input) => {
			const clips = await generateVideo(target, input.prompt, {
				appId,
				appPermission,
				provider: input.provider,
				model: input.model,
				requestId: input.request_id,
				inputImages: input.input_images,
				inputVideo: input.input_video,
				inputAudio: input.input_audio,
				durationS: input.duration_s,
				pollIntervalMs,
				providerInput: input.provider_input,
			});
			return await Promise.all(
				clips.map(async (clip) => ({
					url: await inline(clip.url),
					mediaType: clip.mediaType,
				}))
			);
		},
		generateAudio: async (input) => {
			const clips = await generateAudio(target, {
				appId,
				appPermission,
				kind: input.kind,
				prompt: input.prompt,
				provider: input.provider,
				model: input.model,
				durationS: input.duration_s,
				pollIntervalMs,
				providerInput: input.provider_input,
				requestId: input.request_id,
			});
			return await Promise.all(
				clips.map(async (clip) => {
					const url = await inline(clip.url);
					return { url, mediaType: inlinedMediaType(url, clip.mediaType) };
				})
			);
		},
	};
}
