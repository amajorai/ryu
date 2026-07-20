// Island text-to-speech preference: the cross-process contract persisted in Core
// under the `island-tts` key. The desktop writes it from its Island settings; the
// island companion reads it on startup, subscribes to live changes, and uses it
// to decide whether to speak assistant replies aloud and which engine/voice to
// use. Mirrors `shared/voice.ts`: a plain schema with no `@ryu/ui` dependency
// (the main process externalizes workspace deps).
//
// The default engine is Kokoro 82M (`kokoro`) — an open-weight, CPU-friendly ONNX
// TTS served by the Ryu TTS sidecar, whose model is fetched during onboarding
// alongside the other local defaults (the built-in OuteTTS is the fallback) — so
// speech works out of the box. Swappable, never a lock.

/** Preference key shared with the desktop's preferences client + Core KV store. */
export const ISLAND_TTS_PREF_KEY = "island-tts";

/** Default TTS engine: the bundled, auto-downloaded Kokoro 82M. */
export const DEFAULT_ISLAND_TTS_ENGINE = "kokoro";

/** The speak-replies blob persisted under {@link ISLAND_TTS_PREF_KEY}. */
export interface IslandTtsPrefs {
	/** Speak assistant replies aloud. */
	enabled: boolean;
	/** TTS engine id (`kokoro` default, `outetts` fallback, or another sidecar engine). */
	engine: string;
	/** Voice id (engine-specific); empty = the engine's default voice. */
	voice: string;
}

/** Default: speak replies on, Kokoro 82M, the engine's default voice. */
export const DEFAULT_ISLAND_TTS_PREFS: IslandTtsPrefs = {
	enabled: true,
	engine: DEFAULT_ISLAND_TTS_ENGINE,
	voice: "",
};

/**
 * Tolerantly coerce a raw preference value (JSON string from Core, or `null`)
 * into {@link IslandTtsPrefs}. Falls back to the default for any missing/unknown
 * field so a malformed blob never breaks playback.
 */
export function parseIslandTtsPrefs(raw: string | null): IslandTtsPrefs {
	if (!raw) {
		return DEFAULT_ISLAND_TTS_PREFS;
	}
	try {
		const parsed = JSON.parse(raw) as Partial<IslandTtsPrefs>;
		return {
			enabled: parsed.enabled !== false,
			engine:
				typeof parsed.engine === "string" && parsed.engine.length > 0
					? parsed.engine
					: DEFAULT_ISLAND_TTS_ENGINE,
			voice: typeof parsed.voice === "string" ? parsed.voice : "",
		};
	} catch {
		return DEFAULT_ISLAND_TTS_PREFS;
	}
}
