// Companion `media.transcribe` for the island host.
//
// The island renderer cannot reach Core directly (CORS excludes Electron origins),
// so transcription goes through the existing `window.island.core.transcribe` IPC,
// which posts the WAV to Core's `/api/voice/transcribe`. The engine is the user's
// Voice Recognition choice (the shared `voice-input` preference the desktop writes),
// matching the desktop host and first-party voice input: with nothing stored it is
// the Voice Recognition default (Parakeet), exactly as Island's own voice input
// resolves it. Only when the preference cannot be read at all is the engine left
// empty so Core uses its default.

import type { HostServices } from "@ryu/app-host/rpc";
import type {
	CoreTranscribeOptions,
	CoreTranscribeResult,
} from "../../shared/ipc.ts";
import { parseVoicePrefs } from "../../shared/voice.ts";

/** The island IPC surface this service needs (injected so tests can fake it). */
export interface IslandTranscribeBridge {
	readVoicePrefs(): Promise<string | null>;
	transcribe(
		audio: ArrayBuffer,
		engine: string,
		options?: CoreTranscribeOptions
	): Promise<CoreTranscribeResult>;
}

type TranscribeAudio = NonNullable<HostServices["transcribeAudio"]>;

/** Resolve the user's Voice Recognition engine (the settings default when none is
 *  stored); `""` lets Core pick its default only when the read itself fails. */
export async function islandVoiceEngine(
	bridge: Pick<IslandTranscribeBridge, "readVoicePrefs">
): Promise<string> {
	try {
		return parseVoicePrefs(await bridge.readVoicePrefs()).engine;
	} catch {
		return "";
	}
}

/** Decode a companion-supplied `data:` URL. Other URL schemes are refused so a
 *  frame cannot make the trusted host fetch an arbitrary address. */
async function dataUrlBytes(audio: string): Promise<ArrayBuffer> {
	if (!audio.startsWith("data:")) {
		throw new Error("media.transcribe expects a data: URL");
	}
	const response = await fetch(audio);
	return await response.arrayBuffer();
}

/** Build the island host's `transcribeAudio` service over the given bridge. */
export function createIslandTranscribeAudio(
	bridge: IslandTranscribeBridge
): TranscribeAudio {
	return async (input) => {
		const [bytes, engine] = await Promise.all([
			dataUrlBytes(input.audio),
			islandVoiceEngine(bridge),
		]);
		const options: CoreTranscribeOptions = {
			filename: input.filename ?? "recording.wav",
		};
		if (input.detailed) {
			options.detailed = true;
		}
		const result = await bridge.transcribe(bytes, engine, options);
		if (!result.available) {
			throw new Error(result.reason || "Transcription failed.");
		}
		if (input.detailed) {
			return result.detail ?? { text: result.text.trim(), segments: [] };
		}
		return result.text.trim();
	};
}

/** The production bridge over `window.island`. */
export const islandTranscribeBridge: IslandTranscribeBridge = {
	readVoicePrefs: () => window.island.voice.get(),
	transcribe: (audio, engine, options) =>
		window.island.core.transcribe(audio, engine, options),
};
