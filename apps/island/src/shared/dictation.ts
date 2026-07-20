// System-wide dictation preference: the cross-process contract persisted in Core
// under the `dictation` key. Separate from `voice-input` (`shared/voice.ts`) on
// purpose — voice input drops a transcript into the island chat to run an agent,
// while dictation types the transcript straight into whatever native app has OS
// focus (WhisprFlow / SuperWhisper style). Each gets its own global shortcut so
// the two never fight over one key.
//
// The desktop writes this blob from its Island settings; the island companion (a
// separate Electron process) reads it on startup, subscribes to live changes, and
// uses it to (1) register the dictation global shortcut and (2) drive the capture
// → transcribe → optional post-process → insert pipeline.
//
// Like every Ryu default, the engine/model/shortcut/insertion are swappable,
// never a lock.

import type { VoiceEngine } from "./voice.ts";

/** Preference key shared with the desktop's preferences client + Core KV store. */
export const DICTATION_PREF_KEY = "dictation";

/**
 * How the dictation shortcut behaves. Mirrors {@link VoiceInputMode}:
 * - `"push-to-talk"`: hold the key to record, release to stop + insert. Needs a
 *   global key-*up* signal (the main process observes it through the shared
 *   `uiohook` hold hook). Falls back to `"toggle"` for any accelerator whose
 *   primary key cannot be mapped to a hook keycode.
 * - `"toggle"`: press once to start, again to stop.
 */
export type DictationMode = "toggle" | "push-to-talk";

/**
 * How the transcribed (and optionally post-processed) text lands in the focused
 * app:
 * - `"type"`: synthetic Unicode keystrokes via ghost (`ghost__ghost_type`). No
 *   clipboard clobber; works everywhere; slightly slower for long dictations.
 * - `"paste"`: write the text to the clipboard, then send the paste chord
 *   (`pasteKeys`). Instant even for long text; can restore the prior clipboard.
 */
export type DictationInsertMode = "type" | "paste";

/**
 * Optional LLM cleanup of the raw transcript before it is inserted. `agent` picks
 * where it runs: empty = the fast local default model (one `/v1/chat/completions`
 * turn through the gateway), otherwise a full agent id (e.g. the flagship `ryu`).
 * Fails open — if the model is unavailable or returns empty, the raw transcript
 * is inserted unchanged, so post-processing never silently swallows speech.
 */
export interface DictationPostProcess {
	/** Agent id to run cleanup through; empty = fast local default model. */
	agent: string;
	enabled: boolean;
	/** System prompt handed the cleanup model. */
	prompt: string;
}

/** The dictation settings blob persisted under {@link DICTATION_PREF_KEY}. */
export interface DictationPrefs {
	/** Press Enter after inserting (send the message / newline). */
	autoSend: boolean;
	enabled: boolean;
	/** Transcription engine — the `?engine=` value Core's transcribe endpoint takes. */
	engine: VoiceEngine;
	insertMode: DictationInsertMode;
	mode: DictationMode;
	/**
	 * Paste chord for `insertMode: "paste"`, as `+`-joined tokens (e.g. `"ctrl+v"`,
	 * `"cmd+shift+v"`). Empty = the platform default (`cmd+v` on macOS, else
	 * `ctrl+v`), resolved in the main process where the platform is known.
	 */
	pasteKeys: string;
	postProcess: DictationPostProcess;
	/** Restore the pre-paste clipboard after a paste insertion. */
	restoreClipboard: boolean;
	/** Electron accelerator string handed to `globalShortcut.register`. */
	shortcut: string;
}

/** Default cleanup prompt: tidy dictation without changing meaning. */
export const DEFAULT_DICTATION_POSTPROCESS_PROMPT =
	"You clean up dictated speech into polished written text. Fix grammar, punctuation, and capitalization, and remove filler words (um, uh, like, you know) and false starts. Preserve the original meaning and wording as much as possible. Output ONLY the cleaned text, with no preamble, quotes, or commentary.";

/**
 * Default dictation shortcut. Deliberately a chord (not a bare key) so it does not
 * hijack a common single key while the island runs; rebindable in Island settings.
 */
export const DEFAULT_DICTATION_SHORTCUT = "CommandOrControl+Shift+D";

/** Default dictation settings: enabled, hold-to-talk, parakeet, type-insertion. */
export const DEFAULT_DICTATION_PREFS: DictationPrefs = {
	autoSend: false,
	enabled: true,
	engine: "parakeet",
	insertMode: "type",
	mode: "push-to-talk",
	pasteKeys: "",
	postProcess: {
		agent: "",
		enabled: false,
		prompt: DEFAULT_DICTATION_POSTPROCESS_PROMPT,
	},
	restoreClipboard: true,
	shortcut: DEFAULT_DICTATION_SHORTCUT,
};

/** Coerce an unknown value to a known engine, defaulting to parakeet. */
function coerceEngine(value: unknown): VoiceEngine {
	return value === "whisper" ? "whisper" : "parakeet";
}

/** Coerce an unknown value to a known activation mode, defaulting to push-to-talk. */
function coerceMode(value: unknown): DictationMode {
	return value === "toggle" ? "toggle" : "push-to-talk";
}

/** Coerce an unknown value to a known insertion mode, defaulting to type. */
function coerceInsertMode(value: unknown): DictationInsertMode {
	return value === "paste" ? "paste" : "type";
}

/** Parse the optional post-process block, filling every field from the default. */
function parsePostProcess(value: unknown): DictationPostProcess {
	const raw = (value ?? {}) as Partial<DictationPostProcess>;
	const prompt =
		typeof raw.prompt === "string" && raw.prompt.trim().length > 0
			? raw.prompt
			: DEFAULT_DICTATION_POSTPROCESS_PROMPT;
	return {
		agent: typeof raw.agent === "string" ? raw.agent : "",
		enabled: raw.enabled === true,
		prompt,
	};
}

/**
 * Tolerantly coerce a raw preference value (JSON string from Core, or `null`)
 * into {@link DictationPrefs}. Falls back to the default for any missing/unknown
 * field so a malformed blob never breaks shortcut registration or capture.
 */
export function parseDictationPrefs(raw: string | null): DictationPrefs {
	if (!raw) {
		return DEFAULT_DICTATION_PREFS;
	}
	try {
		const parsed = JSON.parse(raw) as Partial<DictationPrefs>;
		const shortcut =
			typeof parsed.shortcut === "string" && parsed.shortcut.trim().length > 0
				? parsed.shortcut.trim()
				: DEFAULT_DICTATION_SHORTCUT;
		return {
			autoSend: parsed.autoSend === true,
			enabled: parsed.enabled !== false,
			engine: coerceEngine(parsed.engine),
			insertMode: coerceInsertMode(parsed.insertMode),
			mode: coerceMode(parsed.mode),
			pasteKeys:
				typeof parsed.pasteKeys === "string" ? parsed.pasteKeys.trim() : "",
			postProcess: parsePostProcess(parsed.postProcess),
			restoreClipboard: parsed.restoreClipboard !== false,
			shortcut,
		};
	} catch {
		return DEFAULT_DICTATION_PREFS;
	}
}
