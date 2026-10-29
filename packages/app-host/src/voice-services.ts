import type { ApiTarget } from "@ryuhq/core-client/client";
import {
	installTtsEngine,
	listTtsEngines,
	speakText,
	speechAudioMime,
} from "@ryuhq/core-client/voice";
import { z } from "zod";
import type { HostServices } from "./rpc.ts";

export const VOICE_AUDIO_BYTE_LIMIT = 32 * 1024 * 1024;

const voiceDataUrlSchema = z.string();

/** Convert host-owned audio without exposing a node URL or credential. The data
 * URL keeps the real container MIME (WAV, MP3, Ogg, FLAC); an untyped blob is a
 * legacy WAV response and anything else is refused rather than mislabelled. */
export function voiceAudioDataUrl(blob: Blob): Promise<string> {
	if (blob.size > VOICE_AUDIO_BYTE_LIMIT) {
		return Promise.reject(
			new Error("Speech audio exceeds the bridge size limit")
		);
	}
	const mime = speechAudioMime(blob.type);
	if (!mime) {
		return Promise.reject(new Error("Speech audio has an unsupported type"));
	}
	const typed = blob.type === mime ? blob : new Blob([blob], { type: mime });
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onerror = () => reject(new Error("Speech audio could not be read"));
		reader.onload = () => {
			const result = voiceDataUrlSchema.safeParse(reader.result);
			if (!result.success) {
				reject(new Error("Speech audio did not produce a data URL"));
				return;
			}
			resolve(result.data);
		};
		reader.readAsDataURL(typed);
	});
}

/** Desktop, browser-extension and native hosts use the same governed voice client. */
export function buildVoiceServices(
	target: ApiTarget,
	pluginId: string,
	permission: string | undefined,
	encodeAudio: (blob: Blob) => Promise<string> = voiceAudioDataUrl
): Pick<HostServices, "ttsSpeak" | "listTtsEngines" | "installTtsEngine"> {
	return {
		listTtsEngines: () => listTtsEngines(target),
		installTtsEngine: ({ engine }) =>
			installTtsEngine(target, engine, {
				appId: pluginId,
				appPermission: "voice.models.manage",
			}),
		ttsSpeak: async (input) =>
			encodeAudio(
				await speakText(target, input.text, {
					appId: permission ? pluginId : undefined,
					appPermission: permission,
					engine: input.engine,
					voice: input.voice,
					speed: input.speed,
					language: input.language,
					requestId: input.request_id,
					referenceAudioDataUrl: input.reference_audio_data_url,
					seed: input.seed,
					instruct: input.instruct,
					referenceText: input.reference_text,
					effects: input.effects,
					normalize: input.normalize,
					format: input.format,
				})
			),
	};
}
