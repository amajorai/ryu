// Companion `media.transcribe` uses the user's Voice Recognition engine.
//
// First-party voice input (the composer and chat page) reads the shared
// `voice-input` preference and passes its engine as `?engine=` to Core's
// `/api/voice/transcribe`. Companion apps get the same model choice: the host
// resolves the engine per request so a settings change applies on the next clip.
// With nothing stored, `getVoiceInputPrefs` yields the Voice Recognition default
// (Parakeet), as Island's host resolves it too. Only when the preference cannot
// be read at all is the engine left undefined so Core uses its own default.

/** Resolve the engine to send, or `undefined` to let Core choose its default. */
export async function companionVoiceEngine(
	readPrefs: () => Promise<{ engine: string }>
): Promise<string | undefined> {
	try {
		const engine = (await readPrefs()).engine.trim();
		return engine.length > 0 ? engine : undefined;
	} catch {
		return undefined;
	}
}

/** The Core calls the companion `transcribeAudio` service needs (injected so
 *  tests can fake them). */
export interface CompanionTranscribeDeps<Detail> {
	readPrefs(): Promise<{ engine: string }>;
	transcribe(
		audio: Blob,
		filename: string,
		engine: string | undefined
	): Promise<string>;
	transcribeDetailed(
		audio: Blob,
		filename: string,
		engine: string | undefined
	): Promise<Detail>;
}

/** Decode a companion-supplied `data:` URL. Other URL schemes are refused so a
 *  frame cannot make the trusted host fetch an arbitrary address. */
export async function companionAudioBlob(audio: string): Promise<Blob> {
	if (!audio.startsWith("data:")) {
		throw new Error("media.transcribe expects a data: URL");
	}
	return await (await fetch(audio)).blob();
}

/** Build the desktop host's companion `transcribeAudio` service: decode the
 *  clip and send it with the user's Voice Recognition engine. */
export function createCompanionTranscribeAudio<Detail>(
	deps: CompanionTranscribeDeps<Detail>
) {
	return async (input: {
		audio: string;
		detailed?: boolean;
		filename?: string;
	}): Promise<string | Detail> => {
		const [blob, engine] = await Promise.all([
			companionAudioBlob(input.audio),
			companionVoiceEngine(deps.readPrefs),
		]);
		const filename = input.filename ?? "recording.wav";
		return input.detailed
			? await deps.transcribeDetailed(blob, filename, engine)
			: await deps.transcribe(blob, filename, engine);
	};
}
