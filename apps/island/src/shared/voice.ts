// Voice-input preference: the cross-process contract persisted in Core under the
// `voice-input` key. The desktop writes it from its Voice settings; the island
// companion (a separate Electron process that cannot share the desktop's
// localStorage) reads it on startup, subscribes to live changes, and uses it to
// (1) register the push-to-talk global shortcut and (2) pick the transcription
// engine. Mirrors `shared/appearance.ts`: a plain schema with no `@ryu/ui`
// dependency, because the main process (which registers the shortcut and posts
// audio to Core) externalizes workspace deps and cannot import `@ryu/ui`.
//
// Like every Ryu default, the engine/model/shortcut are swappable, never a lock.

/** Preference key shared with the desktop's preferences client + Core KV store. */
export const VOICE_PREF_KEY = "voice-input";

/**
 * Transcription engine. The value is the `?engine=` parameter Core's
 * `/api/voice/transcribe` understands (parakeet v3, the in-process ONNX engine,
 * is the default; whisper.cpp is the alternative).
 */
export type VoiceEngine = "whisper" | "parakeet";

/**
 * How the push-to-talk shortcut behaves:
 * - `"toggle"`: press the activation key once to start, again to stop (hands-free;
 *   the shortcut fires only on key-down, so this is the default and works with any
 *   accelerator).
 * - `"push-to-talk"`: hold the activation key to record, release to stop. Needs a
 *   global key-*up* signal, which Electron's `globalShortcut` cannot provide, so
 *   the main process observes the release through a low-level key hook
 *   (`uiohook-napi`). Falls back to `"toggle"` for any accelerator whose primary
 *   key it cannot map to a hook keycode.
 */
export type VoiceInputMode = "toggle" | "push-to-talk";

/**
 * The voice-input settings blob persisted under {@link VOICE_PREF_KEY}.
 *
 * `shortcut` is an Electron accelerator string (e.g. `"CommandOrControl+Shift+A"`)
 * so the main process can hand it straight to `globalShortcut.register`.
 * `mode` picks toggle vs. hold-to-talk (see {@link VoiceInputMode}).
 * `model` is the engine's bundled model id; it is informational today (Core's
 * transcribe endpoint takes no model parameter — each engine serves a single
 * bundled model) but is carried so a future per-engine model picker is additive.
 */
export interface VoiceInputPrefs {
	enabled: boolean;
	engine: VoiceEngine;
	mode: VoiceInputMode;
	model: string;
	shortcut: string;
}

/** Default activation behavior: press-to-start / press-to-stop (no key hook). */
export const DEFAULT_VOICE_MODE: VoiceInputMode = "toggle";

/**
 * Default push-to-talk accelerator. Deliberately NOT a bare `Ctrl+A` (that would
 * hijack select-all everywhere while the island runs); it stays rebindable in the
 * desktop's Voice settings, where a user can set `Ctrl+A` if they insist.
 */
export const DEFAULT_VOICE_SHORTCUT = "CommandOrControl+Shift+A";

/** Bundled model id per engine (the single model each engine serves today). */
export const VOICE_ENGINE_MODELS: Record<VoiceEngine, string> = {
	whisper: "ggml-base.en",
	parakeet: "parakeet-tdt-0.6b-v3",
};

/** Default voice-input settings: enabled, parakeet, safe rebindable shortcut. */
export const DEFAULT_VOICE_PREFS: VoiceInputPrefs = {
	enabled: true,
	engine: "parakeet",
	mode: DEFAULT_VOICE_MODE,
	model: VOICE_ENGINE_MODELS.parakeet,
	shortcut: DEFAULT_VOICE_SHORTCUT,
};

/** Coerce an unknown value to a known engine, defaulting to parakeet. */
function coerceEngine(value: unknown): VoiceEngine {
	return value === "whisper" ? "whisper" : "parakeet";
}

/** Coerce an unknown value to a known activation mode, defaulting to toggle. */
function coerceMode(value: unknown): VoiceInputMode {
	return value === "push-to-talk" ? "push-to-talk" : "toggle";
}

/**
 * Tolerantly coerce a raw preference value (JSON string from Core, or `null`)
 * into {@link VoiceInputPrefs}. Falls back to the default for any missing/unknown
 * field so a malformed blob never breaks shortcut registration or capture.
 */
export function parseVoicePrefs(raw: string | null): VoiceInputPrefs {
	if (!raw) {
		return DEFAULT_VOICE_PREFS;
	}
	try {
		const parsed = JSON.parse(raw) as Partial<VoiceInputPrefs>;
		const engine = coerceEngine(parsed.engine);
		const shortcut =
			typeof parsed.shortcut === "string" && parsed.shortcut.trim().length > 0
				? parsed.shortcut.trim()
				: DEFAULT_VOICE_SHORTCUT;
		const model =
			typeof parsed.model === "string" && parsed.model.length > 0
				? parsed.model
				: VOICE_ENGINE_MODELS[engine];
		return {
			enabled: parsed.enabled !== false,
			engine,
			mode: coerceMode(parsed.mode),
			model,
			shortcut,
		};
	} catch {
		return DEFAULT_VOICE_PREFS;
	}
}
