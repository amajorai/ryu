// apps/desktop/src/lib/api/preferences.ts
//
// Typed client for Core's key-value preferences store (`/api/preferences/:key`).
// Used to publish the theme blob so other surfaces (the island companion) render
// with the exact same preset. Core is the cross-process channel; localStorage
// stays the local cache.

import { THEME_PREF_KEY, type ThemePrefs } from "@ryu/ui/theme/prefs";
import { type ApiTarget, request } from "./client.ts";
import type { RouteStrategy, SmartRoutingConfig } from "./gateway.ts";

interface PreferenceWire {
	key: string;
	value: string;
}

/** Read a raw preference value (JSON string) by key, or null if unset/unreachable. */
export async function getPreference(
	target: ApiTarget,
	key: string
): Promise<string | null> {
	try {
		const data = await request<PreferenceWire>(
			target,
			`/api/preferences/${key}`
		);
		return data.value;
	} catch {
		return null;
	}
}

/** Write a raw preference value (JSON string) by key. Returns success. */
export async function setPreference(
	target: ApiTarget,
	key: string,
	value: string
): Promise<boolean> {
	try {
		await request(target, `/api/preferences/${key}`, {
			method: "PUT",
			body: { value },
		});
		return true;
	} catch {
		return false;
	}
}

// --- Island appearance ----------------------------------------------------
// The island companion's background treatment, shared cross-process via Core
// (the island reads this key on startup and reconfigures its window). The shape
// is a JSON blob `{ background }`; the string key matches the island's
// `APPEARANCE_PREF_KEY` (apps/island/src/shared/appearance.ts).

export const ISLAND_APPEARANCE_PREF_KEY = "island-appearance";

/** The island background treatment: tinted glass vs native OS material. */
export type IslandBackground = "translucent" | "acrylic" | "mica";

/** Read the island background, defaulting to `translucent`. */
export async function getIslandBackground(
	target: ApiTarget
): Promise<IslandBackground> {
	const raw = await getPreference(target, ISLAND_APPEARANCE_PREF_KEY);
	if (!raw) {
		return "translucent";
	}
	try {
		const parsed = JSON.parse(raw) as { background?: unknown };
		if (parsed.background === "acrylic") {
			return "acrylic";
		}
		if (parsed.background === "mica") {
			return "mica";
		}
		return "translucent";
	} catch {
		return "translucent";
	}
}

/** Write the island background. Returns success. */
export function setIslandBackground(
	target: ApiTarget,
	background: IslandBackground
): Promise<boolean> {
	return setPreference(
		target,
		ISLAND_APPEARANCE_PREF_KEY,
		JSON.stringify({ background })
	);
}

// --- Island edge offset -----------------------------------------------------
// The gap (in pixels) between the island companion and whichever screen edge it
// docks to. One scalar, applied per-axis: docking to an edge insets along that
// edge, a corner insets on both axes at once. Shared cross-process via Core (the
// island reads this key on startup, subscribes to changes, and re-docks live).
// Stored raw (a bare number string, NOT JSON-wrapped) under a key that matches
// the island's `EDGE_OFFSET_PREF_KEY` (apps/island/src/shared/edge-offset.ts).

export const ISLAND_EDGE_OFFSET_PREF_KEY = "island-edge-offset";

/**
 * Default gap from a screen edge, in pixels (mirrors the island's default in
 * apps/island/src/shared/edge-offset.ts). macOS docks flush (0); other platforms
 * inset by 20.
 */
export const DEFAULT_ISLAND_EDGE_OFFSET = navigator.userAgent.includes("Mac")
	? 0
	: 20;

/** Smallest selectable offset (flush against the edge). */
export const MIN_ISLAND_EDGE_OFFSET = 0;

/** Largest selectable offset; the island's snap math clamps to stay on-screen. */
export const MAX_ISLAND_EDGE_OFFSET = 96;

/** Clamp an arbitrary number into the supported, whole-pixel offset range. */
export function clampIslandEdgeOffset(value: number): number {
	return Math.min(
		MAX_ISLAND_EDGE_OFFSET,
		Math.max(MIN_ISLAND_EDGE_OFFSET, Math.round(value))
	);
}

/** Read the saved island edge offset, defaulting to {@link DEFAULT_ISLAND_EDGE_OFFSET}. */
export async function getIslandEdgeOffset(target: ApiTarget): Promise<number> {
	const raw = await getPreference(target, ISLAND_EDGE_OFFSET_PREF_KEY);
	if (raw === null) {
		return DEFAULT_ISLAND_EDGE_OFFSET;
	}
	const value = Number(raw.trim());
	return Number.isFinite(value)
		? clampIslandEdgeOffset(value)
		: DEFAULT_ISLAND_EDGE_OFFSET;
}

/** Write the island edge offset (clamped). Returns success. */
export function setIslandEdgeOffset(
	target: ApiTarget,
	offset: number
): Promise<boolean> {
	return setPreference(
		target,
		ISLAND_EDGE_OFFSET_PREF_KEY,
		String(clampIslandEdgeOffset(offset))
	);
}

// --- Island auto-jump -------------------------------------------------------
// When on, the island companion follows the user to whichever desktop/monitor
// they are active on (the one under the cursor), re-docking to the same zone on
// the new display. Shared cross-process via Core (the island reads this key on
// startup, subscribes to changes, and starts/stops the follow loop live). Stored
// raw (a bare boolean string, NOT JSON-wrapped) under a key that matches the
// island's `AUTO_JUMP_PREF_KEY` (apps/island/src/shared/auto-jump.ts).

export const ISLAND_AUTO_JUMP_PREF_KEY = "island-auto-jump";

/** Default: off, so the island stays put until the user opts in. */
export const DEFAULT_ISLAND_AUTO_JUMP = false;

/** Read the saved island auto-jump flag, defaulting to {@link DEFAULT_ISLAND_AUTO_JUMP}. */
export async function getIslandAutoJump(target: ApiTarget): Promise<boolean> {
	const raw = await getPreference(target, ISLAND_AUTO_JUMP_PREF_KEY);
	if (raw === null) {
		return DEFAULT_ISLAND_AUTO_JUMP;
	}
	const value = raw.trim().toLowerCase();
	if (value === "true" || value === "1") {
		return true;
	}
	if (value === "false" || value === "0") {
		return false;
	}
	return DEFAULT_ISLAND_AUTO_JUMP;
}

/** Write the island auto-jump flag (as a bare boolean string). Returns success. */
export function setIslandAutoJump(
	target: ApiTarget,
	enabled: boolean
): Promise<boolean> {
	return setPreference(target, ISLAND_AUTO_JUMP_PREF_KEY, String(enabled));
}

/** Tolerantly coerce a bare boolean preference string, with a default fallback. */
function parseBoolPreference(raw: string | null, fallback: boolean): boolean {
	if (raw === null) {
		return fallback;
	}
	const value = raw.trim().toLowerCase();
	if (value === "true" || value === "1") {
		return true;
	}
	if (value === "false" || value === "0") {
		return false;
	}
	return fallback;
}

// --- Island hide-on-fullscreen ---------------------------------------------
// When on, the island companion hides itself while another app is running
// fullscreen (a fullscreen video, a game, a presentation) and reappears when that
// app exits. Shared cross-process via Core (the island reads this key on startup,
// subscribes to changes, and starts/stops its fullscreen poll loop live). Stored
// raw (a bare boolean string, NOT JSON-wrapped) under a key that matches the
// island's `HIDE_ON_FULLSCREEN_PREF_KEY` (apps/island/src/shared/hide-on-fullscreen.ts).
// Detection is Windows-only today; the preference is stored on every platform.

export const ISLAND_HIDE_ON_FULLSCREEN_PREF_KEY = "island-hide-on-fullscreen";

/** Default: on, so the island stays out of fullscreen content unless opted out. */
export const DEFAULT_ISLAND_HIDE_ON_FULLSCREEN = true;

/** Read the saved hide-on-fullscreen flag, defaulting to {@link DEFAULT_ISLAND_HIDE_ON_FULLSCREEN}. */
export async function getIslandHideOnFullscreen(
	target: ApiTarget
): Promise<boolean> {
	const raw = await getPreference(target, ISLAND_HIDE_ON_FULLSCREEN_PREF_KEY);
	return parseBoolPreference(raw, DEFAULT_ISLAND_HIDE_ON_FULLSCREEN);
}

/** Write the hide-on-fullscreen flag (as a bare boolean string). Returns success. */
export function setIslandHideOnFullscreen(
	target: ApiTarget,
	enabled: boolean
): Promise<boolean> {
	return setPreference(
		target,
		ISLAND_HIDE_ON_FULLSCREEN_PREF_KEY,
		String(enabled)
	);
}

// --- Island screen privacy --------------------------------------------------
// When on, the island window (and its drag overlay) is excluded from screen
// capture — visible to the user on their physical display but omitted from
// screenshots, screen recordings, and screen-sharing (meetings). Shared
// cross-process via Core (the island reads this key on startup, subscribes to
// changes, and toggles `setContentProtection` live). Stored raw (a bare boolean
// string, NOT JSON-wrapped) under a key that matches the island's
// `SCREEN_PRIVACY_PREF_KEY` (apps/island/src/shared/screen-privacy.ts).

export const ISLAND_SCREEN_PRIVACY_PREF_KEY = "island-screen-privacy";

/** Default: on, so the island is excluded from screen capture unless opted out. */
export const DEFAULT_ISLAND_SCREEN_PRIVACY = true;

/** Read the saved screen-privacy flag, defaulting to {@link DEFAULT_ISLAND_SCREEN_PRIVACY}. */
export async function getIslandScreenPrivacy(
	target: ApiTarget
): Promise<boolean> {
	const raw = await getPreference(target, ISLAND_SCREEN_PRIVACY_PREF_KEY);
	return parseBoolPreference(raw, DEFAULT_ISLAND_SCREEN_PRIVACY);
}

/** Write the screen-privacy flag (as a bare boolean string). Returns success. */
export function setIslandScreenPrivacy(
	target: ApiTarget,
	enabled: boolean
): Promise<boolean> {
	return setPreference(target, ISLAND_SCREEN_PRIVACY_PREF_KEY, String(enabled));
}

// --- Island command shortcut ------------------------------------------------
// The global hotkey that summons the island companion's command bar (show +
// focus + open the palette so you can type into the island). Shared cross-process
// via Core: the island reads this key on startup, subscribes to changes, and
// re-registers the global accelerator live. Stored raw (a bare Electron
// accelerator string, NOT JSON-wrapped) under a key that matches the island's
// `COMMAND_SHORTCUT_PREF_KEY` (apps/island/src/shared/command-shortcut.ts).

export const ISLAND_COMMAND_SHORTCUT_PREF_KEY = "island-command-shortcut";

/** Default summon accelerator (mirrors the island's `DEFAULT_COMMAND_SHORTCUT`). */
export const DEFAULT_ISLAND_COMMAND_SHORTCUT = "CommandOrControl+Shift+Space";

/** Read the saved island command-bar shortcut, defaulting to {@link DEFAULT_ISLAND_COMMAND_SHORTCUT}. */
export async function getIslandCommandShortcut(
	target: ApiTarget
): Promise<string> {
	const raw = await getPreference(target, ISLAND_COMMAND_SHORTCUT_PREF_KEY);
	if (raw === null) {
		return DEFAULT_ISLAND_COMMAND_SHORTCUT;
	}
	const trimmed = raw.trim();
	return trimmed.length > 0 ? trimmed : DEFAULT_ISLAND_COMMAND_SHORTCUT;
}

/** Write the island command-bar shortcut (raw, trimmed). Returns success. */
export function setIslandCommandShortcut(
	target: ApiTarget,
	shortcut: string
): Promise<boolean> {
	return setPreference(
		target,
		ISLAND_COMMAND_SHORTCUT_PREF_KEY,
		shortcut.trim()
	);
}

// --- Keyboard shortcuts -----------------------------------------------------
// The user's keybinding overrides for the unified hotkey system (@ryu/hotkeys).
// A JSON map of action id -> chord string, or `null` for an explicitly cleared
// (unbound) action; an absent id means "use the registry default". Stored under
// Core so every desktop window on the node reads the same set. Values are the
// canonical cross-platform chord format ("Mod+Shift+K").

export const KEYBINDINGS_PREF_KEY = "keybindings";

/** A saved keybinding overrides map (action id -> chord, or null when cleared). */
export type KeybindingOverrides = Record<string, string | null>;

/** Read the saved keybinding overrides, or an empty map when unset/unreachable. */
export async function getKeybindings(
	target: ApiTarget
): Promise<KeybindingOverrides> {
	const raw = await getPreference(target, KEYBINDINGS_PREF_KEY);
	if (raw === null) {
		return {};
	}
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as KeybindingOverrides;
		}
	} catch {
		// Corrupt blob: fall back to defaults rather than throwing.
	}
	return {};
}

/** Persist the full keybinding overrides map. Returns success. */
export function setKeybindings(
	target: ApiTarget,
	overrides: KeybindingOverrides
): Promise<boolean> {
	return setPreference(target, KEYBINDINGS_PREF_KEY, JSON.stringify(overrides));
}

// --- Island agents ----------------------------------------------------------
// Which agent the island companion uses for (1) its conversational chat — the
// surface a transcribed voice turn or a typed message is sent to — and (2) the
// proactive suggestion engine. Both default to the flagship `ryu` agent (Pi +
// Gateway), the only agent installed out of the box and the one load-bearing for
// most features. An empty string means "Core's default local model" (the fast
// Gemma completion, no agent subprocess). Shared cross-process via Core: the
// island reads this on startup and subscribes to changes, so a switch here
// re-routes both the chat and the proactive loop live. JSON blob; the key matches
// the island's `ISLAND_AGENTS_PREF_KEY` (apps/island/src/shared/agents.ts).

export const ISLAND_AGENTS_PREF_KEY = "island-agents";

/** The default agent id every surface falls back to (the locked flagship). */
export const DEFAULT_AGENT_ID = "ryu";

/** Which agent each island surface routes to. Empty string = default local model. */
export interface IslandAgentPrefs {
	/** Agent for the proactive suggestion engine. */
	proactiveAgent: string;
	/** Agent for the island's conversational chat (voice + typed input). */
	voiceAgent: string;
}

/** Default: both surfaces use the flagship `ryu` agent. */
export const DEFAULT_ISLAND_AGENT_PREFS: IslandAgentPrefs = {
	voiceAgent: DEFAULT_AGENT_ID,
	proactiveAgent: DEFAULT_AGENT_ID,
};

/** Read the island agent routing, falling back to {@link DEFAULT_ISLAND_AGENT_PREFS}. */
export async function getIslandAgentPrefs(
	target: ApiTarget
): Promise<IslandAgentPrefs> {
	const raw = await getPreference(target, ISLAND_AGENTS_PREF_KEY);
	if (!raw) {
		return DEFAULT_ISLAND_AGENT_PREFS;
	}
	try {
		const parsed = JSON.parse(raw) as Partial<IslandAgentPrefs>;
		return {
			voiceAgent:
				typeof parsed.voiceAgent === "string"
					? parsed.voiceAgent
					: DEFAULT_AGENT_ID,
			proactiveAgent:
				typeof parsed.proactiveAgent === "string"
					? parsed.proactiveAgent
					: DEFAULT_AGENT_ID,
		};
	} catch {
		return DEFAULT_ISLAND_AGENT_PREFS;
	}
}

/** Write the island agent routing. Returns success. */
export function setIslandAgentPrefs(
	target: ApiTarget,
	prefs: IslandAgentPrefs
): Promise<boolean> {
	return setPreference(target, ISLAND_AGENTS_PREF_KEY, JSON.stringify(prefs));
}

// --- Island text-to-speech --------------------------------------------------
// The island companion can speak assistant replies aloud. This blob holds the
// enable toggle plus the TTS engine + voice. The default engine is Kokoro 82M
// (`kokoro`) — an open-weight, CPU-friendly ONNX TTS served by the Ryu TTS sidecar,
// whose model is fetched during onboarding alongside the other local defaults (the
// built-in OuteTTS is the fallback) — so speech works out of the box, no setup.
// Shared cross-process via Core: the island reads this
// on startup, subscribes to changes, and on a finished assistant reply posts the
// text to Core's `/api/voice/speak`. JSON blob; the key matches the island's
// `ISLAND_TTS_PREF_KEY` (apps/island/src/shared/tts.ts).

export const ISLAND_TTS_PREF_KEY = "island-tts";

/** The island's speak-replies settings persisted under {@link ISLAND_TTS_PREF_KEY}. */
export interface IslandTtsPrefs {
	/** Speak assistant replies aloud. */
	enabled: boolean;
	/** TTS engine id (`kokoro` default, `outetts` fallback, or another sidecar engine). */
	engine: string;
	/** Voice id (engine-specific); empty = the engine's default voice. */
	voice: string;
}

/** Default TTS engine: the bundled, auto-downloaded Kokoro 82M. */
export const DEFAULT_ISLAND_TTS_ENGINE = "kokoro";

/** Default: speak replies on, built-in OuteTTS, the engine's default voice. */
export const DEFAULT_ISLAND_TTS_PREFS: IslandTtsPrefs = {
	enabled: true,
	engine: DEFAULT_ISLAND_TTS_ENGINE,
	voice: "",
};

/** Read the island TTS settings, falling back to {@link DEFAULT_ISLAND_TTS_PREFS}. */
export async function getIslandTtsPrefs(
	target: ApiTarget
): Promise<IslandTtsPrefs> {
	const raw = await getPreference(target, ISLAND_TTS_PREF_KEY);
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

/** Write the island TTS settings. Returns success. */
export function setIslandTtsPrefs(
	target: ApiTarget,
	prefs: IslandTtsPrefs
): Promise<boolean> {
	return setPreference(target, ISLAND_TTS_PREF_KEY, JSON.stringify(prefs));
}

// --- Voice mode / desktop chat read-back ------------------------------------
// Separate from `island-tts`: controls whether the desktop app automatically
// speaks assistant replies aloud when a text chat turn finishes. The realtime
// voice-mode WebSocket session always speaks via Core while active; this toggle
// only affects typed chat. Read-back is suppressed while a meeting is recording.

export const VOICE_MODE_READBACK_PREF_KEY = "voice-mode-readback";

/** Desktop chat read-back settings under {@link VOICE_MODE_READBACK_PREF_KEY}. */
export interface VoiceModeReadbackPrefs {
	/** Automatically speak assistant replies when a chat turn completes. */
	enabled: boolean;
}

/** Default: read-back off in desktop chat (manual speak button still works). */
export const DEFAULT_VOICE_MODE_READBACK_PREFS: VoiceModeReadbackPrefs = {
	enabled: false,
};

/** Read desktop chat read-back settings. */
export async function getVoiceModeReadbackPrefs(
	target: ApiTarget
): Promise<VoiceModeReadbackPrefs> {
	const raw = await getPreference(target, VOICE_MODE_READBACK_PREF_KEY);
	if (!raw) {
		return DEFAULT_VOICE_MODE_READBACK_PREFS;
	}
	try {
		const parsed = JSON.parse(raw) as Partial<VoiceModeReadbackPrefs>;
		return { enabled: parsed.enabled === true };
	} catch {
		return DEFAULT_VOICE_MODE_READBACK_PREFS;
	}
}

/** Write desktop chat read-back settings. */
export function setVoiceModeReadbackPrefs(
	target: ApiTarget,
	prefs: VoiceModeReadbackPrefs
): Promise<boolean> {
	return setPreference(
		target,
		VOICE_MODE_READBACK_PREF_KEY,
		JSON.stringify(prefs)
	);
}

// --- Desktop TTS engine (local) ---------------------------------------------
// The Voice settings tab persists the default speak engine/voice in localStorage
// (`TtsEngineSettings`). Chat read-back and the per-message speak button read
// these keys — separate from island-tts.

export const DESKTOP_TTS_ENGINE_KEY = "ryu.tts.engine";
export const DESKTOP_TTS_VOICE_KEY = "ryu.tts.voice";
const DEFAULT_DESKTOP_TTS_ENGINE = "kokoro";

/** Desktop default TTS engine + voice from localStorage. */
export function getDesktopTtsPrefs(): { engine: string; voice: string } {
	try {
		return {
			engine:
				localStorage.getItem(DESKTOP_TTS_ENGINE_KEY) ??
				DEFAULT_DESKTOP_TTS_ENGINE,
			voice: localStorage.getItem(DESKTOP_TTS_VOICE_KEY) ?? "",
		};
	} catch {
		return { engine: DEFAULT_DESKTOP_TTS_ENGINE, voice: "" };
	}
}

// --- Island consent (privacy permissions) -----------------------------------
// The island companion's per-capability privacy consent, mirrored cross-process
// via Core. The island stays the locally authoritative hard gate, but it pushes
// every local change to this key and pulls desktop edits back, so these toggles
// are editable here (the island's own Settings tab was removed). The shape is the
// island's `ConsentState`: `chat` is a boolean (defaults true), while
// `contextRead` (screen/window capture via Shadow) and `proactive` (the
// suggestion engine) are tri-state — `true` granted, `false` declined, `null`
// unanswered (the island shows its first-run card while either is `null`). The
// string key matches the island's `ISLAND_CONSENT_PREF_KEY`
// (apps/island/src/shared/consent.ts).

export const ISLAND_CONSENT_PREF_KEY = "island-consent";

/** The island's per-capability privacy consent persisted under {@link ISLAND_CONSENT_PREF_KEY}. */
export interface IslandConsentPrefs {
	/** Talk to Core (the island is a chat surface; defaults on). */
	chat: boolean;
	/** Read screen/window context via Shadow. `null` = unanswered. */
	contextRead: boolean | null;
	/** Run the proactive suggestion engine. `null` = unanswered. */
	proactive: boolean | null;
}

/** Default: chat on, the gated capabilities unanswered (matches the island). */
export const DEFAULT_ISLAND_CONSENT: IslandConsentPrefs = {
	chat: true,
	contextRead: null,
	proactive: null,
};

/** Coerce arbitrary persisted JSON into a strict tri-state value. */
function coerceTriState(value: unknown): boolean | null {
	return value === true || value === false ? value : null;
}

/** Read the island consent, falling back to {@link DEFAULT_ISLAND_CONSENT}. */
export async function getIslandConsent(
	target: ApiTarget
): Promise<IslandConsentPrefs> {
	const raw = await getPreference(target, ISLAND_CONSENT_PREF_KEY);
	if (!raw) {
		return DEFAULT_ISLAND_CONSENT;
	}
	try {
		const parsed = JSON.parse(raw) as Partial<IslandConsentPrefs>;
		return {
			chat: parsed.chat !== false,
			contextRead: coerceTriState(parsed.contextRead),
			proactive: coerceTriState(parsed.proactive),
		};
	} catch {
		return DEFAULT_ISLAND_CONSENT;
	}
}

/** Write the island consent. Returns success. */
export function setIslandConsent(
	target: ApiTarget,
	prefs: IslandConsentPrefs
): Promise<boolean> {
	return setPreference(target, ISLAND_CONSENT_PREF_KEY, JSON.stringify(prefs));
}

// --- Hugging Face access token ----------------------------------------------
// Raises Hugging Face Hub rate limits and unlocks gated model downloads. Stored
// raw (a bare token string, NOT JSON-wrapped) under a key Core reads on startup
// and on change; Core sends it as a bearer token to huggingface.co only.

export const HF_TOKEN_PREF_KEY = "hf-token";

/** Read the saved Hugging Face token, or an empty string if unset. */
export async function getHfToken(target: ApiTarget): Promise<string> {
	return (await getPreference(target, HF_TOKEN_PREF_KEY)) ?? "";
}

/** Write the Hugging Face token (raw, trimmed). An empty string clears it. */
export function setHfToken(target: ApiTarget, token: string): Promise<boolean> {
	return setPreference(target, HF_TOKEN_PREF_KEY, token.trim());
}

// --- Artificial Analysis API key --------------------------------------------
// Enriches the model catalog with independent benchmark stats (intelligence,
// speed, latency, price). Stored raw (a bare key string, NOT JSON-wrapped)
// under a key Core reads on startup and on change; Core sends it only to
// artificialanalysis.ai. The whole catalog works without it.

export const AA_API_KEY_PREF_KEY = "aa-api-key";

/** Read the saved Artificial Analysis API key, or an empty string if unset. */
export async function getAaApiKey(target: ApiTarget): Promise<string> {
	return (await getPreference(target, AA_API_KEY_PREF_KEY)) ?? "";
}

/** Write the Artificial Analysis API key (raw, trimmed). Empty clears it. */
export function setAaApiKey(target: ApiTarget, key: string): Promise<boolean> {
	return setPreference(target, AA_API_KEY_PREF_KEY, key.trim());
}

// --- Artificial Analysis fetch mode -----------------------------------------
// How Core sources the AA model list. "cached" (default) serves a daily on-disk
// cache so the rate-limited API is hit at most once a day; "realtime" bypasses
// the daily cache and fetches live (with only a short dedupe window). Stored raw
// (a bare mode string, NOT JSON-wrapped) under a key Core reads on startup and
// on change.

export const AA_MODE_PREF_KEY = "aa-mode";

/** AA fetch mode: daily on-disk cache (default) vs. live fetch. */
export type AaStatsMode = "cached" | "realtime";

/** Read the saved AA fetch mode, defaulting to `cached`. */
export async function getAaStatsMode(target: ApiTarget): Promise<AaStatsMode> {
	const raw = await getPreference(target, AA_MODE_PREF_KEY);
	return raw === "realtime" ? "realtime" : "cached";
}

/** Write the AA fetch mode. Returns success. */
export function setAaStatsMode(
	target: ApiTarget,
	mode: AaStatsMode
): Promise<boolean> {
	return setPreference(target, AA_MODE_PREF_KEY, mode);
}

// --- Voice input -----------------------------------------------------------
// Push-to-talk voice input for the island companion: the global shortcut, the
// transcription engine/model, and an enable toggle. Shared cross-process via
// Core — the island reads this key on startup, subscribes to changes, registers
// the shortcut, and routes captured audio to Core's transcribe endpoint with the
// chosen engine. The string key matches the island's `VOICE_PREF_KEY`
// (apps/island/src/shared/voice.ts); the shape must stay in sync with its
// `VoiceInputPrefs`.

export const VOICE_PREF_KEY = "voice-input";

/** Transcription engine: the `?engine=` value Core's transcribe route accepts. */
export type VoiceEngine = "whisper" | "parakeet";

/**
 * Activation behavior of the push-to-talk shortcut. `"toggle"` = press once to
 * start, again to stop (default). `"push-to-talk"` = hold to record, release to
 * stop (the island watches the release via a global key hook). Must stay in sync
 * with the island's `VoiceInputMode` (apps/island/src/shared/voice.ts).
 */
export type VoiceInputMode = "toggle" | "push-to-talk";

/** The voice-input settings blob persisted under {@link VOICE_PREF_KEY}. */
export interface VoiceInputPrefs {
	enabled: boolean;
	engine: VoiceEngine;
	/** Toggle vs. hold-to-talk activation (see {@link VoiceInputMode}). */
	mode: VoiceInputMode;
	/** Bundled model id (informational; one model per engine today). */
	model: string;
	/** Electron accelerator string, e.g. `"CommandOrControl+Shift+A"`. */
	shortcut: string;
}

/**
 * Voice engines selectable in settings, with their display label, the sidecar
 * name to check install/run status against (`/api/sidecar/status`), and the
 * single bundled model each serves. Reflects Core's Voice catalog
 * (apps/core/src/catalog/registry.rs); not a lock — adding an engine here + in
 * Core surfaces it without other changes.
 */
export const VOICE_ENGINES: {
	engine: VoiceEngine;
	label: string;
	model: string;
	sidecar: string;
}[] = [
	{
		engine: "parakeet",
		label: "Parakeet v3",
		model: "parakeet-tdt-0.6b-v3",
		sidecar: "parakeet",
	},
	{
		engine: "whisper",
		label: "Whisper",
		model: "ggml-base.en",
		sidecar: "whispercpp",
	},
];

/** Default voice-input settings (mirrors the island's `DEFAULT_VOICE_PREFS`). */
export const DEFAULT_VOICE_PREFS: VoiceInputPrefs = {
	enabled: true,
	engine: "parakeet",
	mode: "toggle",
	model: "parakeet-tdt-0.6b-v3",
	shortcut: "CommandOrControl+Shift+A",
};

/** Read the saved voice-input settings, falling back to defaults. */
export async function getVoiceInputPrefs(
	target: ApiTarget
): Promise<VoiceInputPrefs> {
	const raw = await getPreference(target, VOICE_PREF_KEY);
	if (!raw) {
		return DEFAULT_VOICE_PREFS;
	}
	try {
		const parsed = JSON.parse(raw) as Partial<VoiceInputPrefs>;
		const engine = parsed.engine === "whisper" ? "whisper" : "parakeet";
		return {
			enabled: parsed.enabled !== false,
			engine,
			mode: parsed.mode === "push-to-talk" ? "push-to-talk" : "toggle",
			model:
				typeof parsed.model === "string" && parsed.model.length > 0
					? parsed.model
					: (VOICE_ENGINES.find((e) => e.engine === engine)?.model ??
						DEFAULT_VOICE_PREFS.model),
			shortcut:
				typeof parsed.shortcut === "string" && parsed.shortcut.trim().length > 0
					? parsed.shortcut.trim()
					: DEFAULT_VOICE_PREFS.shortcut,
		};
	} catch {
		return DEFAULT_VOICE_PREFS;
	}
}

/** Write the voice-input settings. Returns success. */
export function setVoiceInputPrefs(
	target: ApiTarget,
	prefs: VoiceInputPrefs
): Promise<boolean> {
	return setPreference(target, VOICE_PREF_KEY, JSON.stringify(prefs));
}

// --- Dictation --------------------------------------------------------------
// System-wide dictation for the island companion: hold a separate global shortcut,
// speak, and the transcript is typed straight into whatever native app has OS
// focus (WhisprFlow / SuperWhisper style) — distinct from voice input, which runs
// an agent in the island chat. The string key matches the island's
// `DICTATION_PREF_KEY` (apps/island/src/shared/dictation.ts); the shape must stay
// in sync with its `DictationPrefs`.

export const DICTATION_PREF_KEY = "dictation";

/** Activation behavior: hold-to-talk (default) vs. press-to-toggle. */
export type DictationMode = "toggle" | "push-to-talk";

/** How the text lands in the focused app: synthetic typing or clipboard paste. */
export type DictationInsertMode = "type" | "paste";

/** Optional LLM cleanup of the transcript before insertion. */
export interface DictationPostProcess {
	/** Agent id to run cleanup through; empty = the fast local default model. */
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
	engine: VoiceEngine;
	insertMode: DictationInsertMode;
	mode: DictationMode;
	/** Paste chord as `+`-joined tokens (empty = platform default `ctrl`/`cmd`+v). */
	pasteKeys: string;
	postProcess: DictationPostProcess;
	/** Restore the pre-paste clipboard after a paste insertion. */
	restoreClipboard: boolean;
	/** Electron accelerator string, e.g. `"CommandOrControl+Shift+D"`. */
	shortcut: string;
}

/** Default cleanup prompt (mirrors the island's default). */
export const DEFAULT_DICTATION_POSTPROCESS_PROMPT =
	"You clean up dictated speech into polished written text. Fix grammar, punctuation, and capitalization, and remove filler words (um, uh, like, you know) and false starts. Preserve the original meaning and wording as much as possible. Output ONLY the cleaned text, with no preamble, quotes, or commentary.";

/** Default dictation settings (mirrors the island's `DEFAULT_DICTATION_PREFS`). */
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
	shortcut: "CommandOrControl+Shift+D",
};

/** Read the saved dictation settings, falling back to defaults. */
export async function getDictationPrefs(
	target: ApiTarget
): Promise<DictationPrefs> {
	const raw = await getPreference(target, DICTATION_PREF_KEY);
	if (!raw) {
		return DEFAULT_DICTATION_PREFS;
	}
	try {
		const parsed = JSON.parse(raw) as Partial<DictationPrefs>;
		const post = (parsed.postProcess ?? {}) as Partial<DictationPostProcess>;
		return {
			autoSend: parsed.autoSend === true,
			enabled: parsed.enabled !== false,
			engine: parsed.engine === "whisper" ? "whisper" : "parakeet",
			insertMode: parsed.insertMode === "paste" ? "paste" : "type",
			mode: parsed.mode === "toggle" ? "toggle" : "push-to-talk",
			pasteKeys:
				typeof parsed.pasteKeys === "string" ? parsed.pasteKeys.trim() : "",
			postProcess: {
				agent: typeof post.agent === "string" ? post.agent : "",
				enabled: post.enabled === true,
				prompt:
					typeof post.prompt === "string" && post.prompt.trim().length > 0
						? post.prompt
						: DEFAULT_DICTATION_POSTPROCESS_PROMPT,
			},
			restoreClipboard: parsed.restoreClipboard !== false,
			shortcut:
				typeof parsed.shortcut === "string" && parsed.shortcut.trim().length > 0
					? parsed.shortcut.trim()
					: DEFAULT_DICTATION_PREFS.shortcut,
		};
	} catch {
		return DEFAULT_DICTATION_PREFS;
	}
}

/** Write the dictation settings. Returns success. */
export function setDictationPrefs(
	target: ApiTarget,
	prefs: DictationPrefs
): Promise<boolean> {
	return setPreference(target, DICTATION_PREF_KEY, JSON.stringify(prefs));
}

// --- Goal judge model -------------------------------------------------------
// The model that judges whether a `/goal` completion condition has been met. An
// empty value means "use the system default chat model". Stored raw (a bare
// model-id string, NOT JSON-wrapped) under a key Core reads at judge time
// (`goal-judge-model`); Core routes the judge call through the Gateway like any
// other model call. Swappable, never hardcoded.

export const GOAL_JUDGE_MODEL_PREF_KEY = "goal-judge-model";

/** Read the saved goal judge model id, or an empty string (use default). */
export async function getGoalJudgeModel(target: ApiTarget): Promise<string> {
	return (await getPreference(target, GOAL_JUDGE_MODEL_PREF_KEY)) ?? "";
}

/** Write the goal judge model id (raw, trimmed). Empty clears it (use default). */
export function setGoalJudgeModel(
	target: ApiTarget,
	modelId: string
): Promise<boolean> {
	return setPreference(target, GOAL_JUDGE_MODEL_PREF_KEY, modelId.trim());
}

// --- Auto-recall (U17) ------------------------------------------------------
// Before each chat turn, Core can automatically retrieve relevant prior knowledge
// (long-term memory + past chat messages, current conversation excluded) and
// inject it into the prompt. DEFAULT ON: an unset pref means enabled; Core treats
// only an explicit "false" as disabled. Stored raw (a bare "true"/"false"
// string). The top-k value caps the number of recalled snippets per turn.

export const AUTO_RECALL_ENABLED_PREF_KEY = "auto-recall-enabled";
export const AUTO_RECALL_TOP_K_PREF_KEY = "auto-recall-top-k";

/** Read whether auto-recall is enabled. Defaults to ON when unset (matches Core). */
export async function getAutoRecallEnabled(
	target: ApiTarget
): Promise<boolean> {
	const raw = await getPreference(target, AUTO_RECALL_ENABLED_PREF_KEY);
	if (raw === null) {
		return true;
	}
	const v = raw.trim().toLowerCase();
	return !(v === "false" || v === "0" || v === "off" || v === "no");
}

/** Persist the auto-recall enabled flag (raw "true"/"false"). */
export function setAutoRecallEnabled(
	target: ApiTarget,
	enabled: boolean
): Promise<boolean> {
	return setPreference(target, AUTO_RECALL_ENABLED_PREF_KEY, String(enabled));
}

// --- Continual learning (consent gate) --------------------------------------
// Global opt-in for turning conversations into learning data (the MetaClaw-style
// loop: experience buffer -> PRM scoring -> skill synthesis -> reward-filtered
// retrain). Defaults OFF — learning never happens unless the user enables it.

export const LEARNING_ENABLED_PREF_KEY = "learning.enabled";

/** Read whether continual learning is enabled. Defaults to OFF when unset. */
export async function getLearningEnabled(target: ApiTarget): Promise<boolean> {
	const raw = await getPreference(target, LEARNING_ENABLED_PREF_KEY);
	if (raw === null) {
		return false;
	}
	const v = raw.trim().toLowerCase();
	return v === "true" || v === "1" || v === "on" || v === "yes";
}

/** Persist the continual-learning opt-in flag (raw "true"/"false"). */
export function setLearningEnabled(
	target: ApiTarget,
	enabled: boolean
): Promise<boolean> {
	return setPreference(target, LEARNING_ENABLED_PREF_KEY, String(enabled));
}

export const LEARNING_SKILLS_ENABLED_PREF_KEY = "learning.skills-enabled";

/**
 * Read whether the local skill-learning loop is enabled. Defaults to ON when
 * unset — it's fully on-device and inbox-gated, so it's the safe default,
 * distinct from the training opt-in (which defaults OFF).
 */
export async function getLearningSkillsEnabled(
	target: ApiTarget
): Promise<boolean> {
	const raw = await getPreference(target, LEARNING_SKILLS_ENABLED_PREF_KEY);
	if (raw === null) {
		return true;
	}
	const v = raw.trim().toLowerCase();
	return v === "true" || v === "1" || v === "on" || v === "yes";
}

/** Persist the local skill-learning opt-in flag (raw "true"/"false"). */
export function setLearningSkillsEnabled(
	target: ApiTarget,
	enabled: boolean
): Promise<boolean> {
	return setPreference(
		target,
		LEARNING_SKILLS_ENABLED_PREF_KEY,
		String(enabled)
	);
}

// --- Skills disclosure mode (progressive vs full) ---------------------------
// Progressive (default): only a skill's name+description is injected up front and
// the model loads full instructions on demand via the `skills__load` tool — saves
// context on low-context models. Full: every enabled skill body is injected each
// turn (the original behavior). Stored as "progressive" | "full" in Core under the
// `skills-disclosure` pref. Only the tool-loop (ACP) plane honors progressive; the
// no-tool chat path always uses full so a weak model is never starved.

export const SKILLS_DISCLOSURE_PREF_KEY = "skills-disclosure";

/** Read whether skills use progressive disclosure. Defaults to ON (progressive). */
export async function getSkillsProgressive(
	target: ApiTarget
): Promise<boolean> {
	const raw = await getPreference(target, SKILLS_DISCLOSURE_PREF_KEY);
	if (raw === null) {
		return true;
	}
	return raw.trim().toLowerCase() !== "full";
}

/** Persist the skills disclosure mode ("progressive" | "full"). */
export function setSkillsProgressive(
	target: ApiTarget,
	progressive: boolean
): Promise<boolean> {
	return setPreference(
		target,
		SKILLS_DISCLOSURE_PREF_KEY,
		progressive ? "progressive" : "full"
	);
}

// --- Side-model config (goal judge + double-check) --------------------------
// Both the goal judge and the double-check reviewer are "side models": a model
// id (free, gateway-routable; empty → system default) plus an effort/thinking
// level (forwarded as `reasoning_effort`, empty → provider default). The picker
// also stores a `provider` key for UI state only — Core ignores it and routes by
// the model id alone, so the dropdowns are suggestions, never a hard constraint.

export const GOAL_JUDGE_EFFORT_PREF_KEY = "goal-judge-effort";
export const DOUBLE_CHECK_MODEL_PREF_KEY = "double-check-model";
export const DOUBLE_CHECK_PROVIDER_PREF_KEY = "double-check-provider";
export const DOUBLE_CHECK_EFFORT_PREF_KEY = "double-check-effort";

/** A side model's config as the picker edits it. `provider` is UI-only. */
export interface SideModelConfig {
	effort: string;
	model: string;
	provider: string;
}

async function getSideModelConfig(
	target: ApiTarget,
	keys: { provider?: string; model: string; effort: string }
): Promise<SideModelConfig> {
	const [provider, model, effort] = await Promise.all([
		keys.provider ? getPreference(target, keys.provider) : Promise.resolve(""),
		getPreference(target, keys.model),
		getPreference(target, keys.effort),
	]);
	return {
		provider: provider ?? "",
		model: model ?? "",
		effort: effort ?? "",
	};
}

async function setSideModelConfig(
	target: ApiTarget,
	keys: { provider?: string; model: string; effort: string },
	cfg: SideModelConfig
): Promise<boolean> {
	const writes = [
		setPreference(target, keys.model, cfg.model.trim()),
		setPreference(target, keys.effort, cfg.effort.trim()),
	];
	if (keys.provider) {
		writes.push(setPreference(target, keys.provider, cfg.provider.trim()));
	}
	const results = await Promise.all(writes);
	return results.every(Boolean);
}

/** Read the goal judge's {provider (UI), model, effort}. */
export function getGoalJudgeConfig(
	target: ApiTarget
): Promise<SideModelConfig> {
	return getSideModelConfig(target, {
		model: GOAL_JUDGE_MODEL_PREF_KEY,
		effort: GOAL_JUDGE_EFFORT_PREF_KEY,
	});
}

/** Write the goal judge's {model, effort} (provider is not persisted for goal). */
export function setGoalJudgeConfig(
	target: ApiTarget,
	cfg: SideModelConfig
): Promise<boolean> {
	return setSideModelConfig(
		target,
		{ model: GOAL_JUDGE_MODEL_PREF_KEY, effort: GOAL_JUDGE_EFFORT_PREF_KEY },
		cfg
	);
}

/** Read the double-check reviewer's {provider, model, effort}. */
export function getDoubleCheckConfig(
	target: ApiTarget
): Promise<SideModelConfig> {
	return getSideModelConfig(target, {
		provider: DOUBLE_CHECK_PROVIDER_PREF_KEY,
		model: DOUBLE_CHECK_MODEL_PREF_KEY,
		effort: DOUBLE_CHECK_EFFORT_PREF_KEY,
	});
}

/** Write the double-check reviewer's {provider (UI), model, effort}. */
export function setDoubleCheckConfig(
	target: ApiTarget,
	cfg: SideModelConfig
): Promise<boolean> {
	return setSideModelConfig(
		target,
		{
			provider: DOUBLE_CHECK_PROVIDER_PREF_KEY,
			model: DOUBLE_CHECK_MODEL_PREF_KEY,
			effort: DOUBLE_CHECK_EFFORT_PREF_KEY,
		},
		cfg
	);
}

// --- Chat auto-rename (title) -----------------------------------------------
// ChatGPT/Claude-style: when a chat gets its first user message, Core names it.
// By default the resident LOCAL model does this DIRECTLY (the first message never
// leaves the machine). Setting a model here routes the title call through the
// Gateway with that model id instead — the fix for cloud-only setups where no
// local engine is resident (so the direct path is a no-op and chats never get
// named). Model + effort persist under `auto-title-*`; the master toggle under
// `auto-title-enabled` (default ON). Core ignores `provider` (UI suggestion only)
// and routes by the model id alone — nothing hardcoded.

export const AUTO_TITLE_MODEL_PREF_KEY = "auto-title-model";
export const AUTO_TITLE_EFFORT_PREF_KEY = "auto-title-effort";
export const AUTO_TITLE_ENABLED_PREF_KEY = "auto-title-enabled";

/** Read the chat-rename model's {model, effort} (provider not persisted). */
export function getChatRenameConfig(
	target: ApiTarget
): Promise<SideModelConfig> {
	return getSideModelConfig(target, {
		model: AUTO_TITLE_MODEL_PREF_KEY,
		effort: AUTO_TITLE_EFFORT_PREF_KEY,
	});
}

/** Write the chat-rename model's {model, effort}. Empty model = default local model. */
export function setChatRenameConfig(
	target: ApiTarget,
	cfg: SideModelConfig
): Promise<boolean> {
	return setSideModelConfig(
		target,
		{ model: AUTO_TITLE_MODEL_PREF_KEY, effort: AUTO_TITLE_EFFORT_PREF_KEY },
		cfg
	);
}

/** Read whether chat auto-rename is enabled. Defaults to ON when unset (matches Core). */
export async function getChatRenameEnabled(
	target: ApiTarget
): Promise<boolean> {
	const raw = await getPreference(target, AUTO_TITLE_ENABLED_PREF_KEY);
	return parsePrefBool(raw, true);
}

/** Persist the chat auto-rename enabled flag (raw "true"/"false"). */
export function setChatRenameEnabled(
	target: ApiTarget,
	enabled: boolean
): Promise<boolean> {
	return setPreference(target, AUTO_TITLE_ENABLED_PREF_KEY, String(enabled));
}

// --- Meeting notes generator ------------------------------------------------
// The model that turns a meeting transcript into structured notes (summary /
// key points / action items / decisions), and the prompt it uses. Core resolves
// these at finalize time and routes the call through the Gateway. Blank = system
// default / built-in prompt — nothing hardcoded.

export const MEETING_NOTES_MODEL_PREF_KEY = "meeting-notes-model";
export const MEETING_NOTES_EFFORT_PREF_KEY = "meeting-notes-effort";
export const MEETING_NOTES_PROMPT_PREF_KEY = "meeting-notes-prompt";

/** Read the meeting-notes generator's {model, effort} (provider not persisted). */
export function getMeetingNotesConfig(
	target: ApiTarget
): Promise<SideModelConfig> {
	return getSideModelConfig(target, {
		model: MEETING_NOTES_MODEL_PREF_KEY,
		effort: MEETING_NOTES_EFFORT_PREF_KEY,
	});
}

/** Write the meeting-notes generator's {model, effort}. */
export function setMeetingNotesConfig(
	target: ApiTarget,
	cfg: SideModelConfig
): Promise<boolean> {
	return setSideModelConfig(
		target,
		{
			model: MEETING_NOTES_MODEL_PREF_KEY,
			effort: MEETING_NOTES_EFFORT_PREF_KEY,
		},
		cfg
	);
}

/** Read the custom meeting-notes prompt (blank = the built-in default). */
export async function getMeetingNotesPrompt(
	target: ApiTarget
): Promise<string> {
	return (await getPreference(target, MEETING_NOTES_PROMPT_PREF_KEY)) ?? "";
}

/** Write the custom meeting-notes prompt (raw — preserve newlines/formatting). */
export function setMeetingNotesPrompt(
	target: ApiTarget,
	prompt: string
): Promise<boolean> {
	return setPreference(target, MEETING_NOTES_PROMPT_PREF_KEY, prompt);
}

// The selected notes template (a prompt preset over the fixed notes schema) and
// whether speaker diarization runs at finalize. Template is a bare id string
// (blank = the `default` template); diarization is a bare boolean, default OFF
// (the model is heavy + HF-gated, so nothing runs until opted in).

export const MEETING_NOTES_TEMPLATE_PREF_KEY = "meeting-notes-template";
export const MEETING_DIARIZATION_ENABLED_PREF_KEY =
	"meeting-diarization-enabled";

/** Read the selected notes template id (blank = the default template). */
export async function getMeetingNotesTemplate(
	target: ApiTarget
): Promise<string> {
	return (await getPreference(target, MEETING_NOTES_TEMPLATE_PREF_KEY)) ?? "";
}

/** Write the selected notes template id. */
export function setMeetingNotesTemplate(
	target: ApiTarget,
	templateId: string
): Promise<boolean> {
	return setPreference(
		target,
		MEETING_NOTES_TEMPLATE_PREF_KEY,
		templateId.trim()
	);
}

/** Read whether speaker diarization runs at finalize. Defaults OFF. */
export async function getMeetingDiarizationEnabled(
	target: ApiTarget
): Promise<boolean> {
	const raw = await getPreference(target, MEETING_DIARIZATION_ENABLED_PREF_KEY);
	return parseBoolPreference(raw, false);
}

/** Write the diarization toggle (as a bare boolean string). */
export function setMeetingDiarizationEnabled(
	target: ApiTarget,
	enabled: boolean
): Promise<boolean> {
	return setPreference(
		target,
		MEETING_DIARIZATION_ENABLED_PREF_KEY,
		String(enabled)
	);
}

// --- Composio API key -------------------------------------------------------
// Connects the user's own Composio account so agents can use Composio actions
// (the gateway executes them) and Composio event triggers. Stored raw (a bare
// key string, NOT JSON-wrapped) under a key Core reads on startup and on change;
// Core injects it into the gateway's environment (enabling its tool loop) and
// uses it to browse the user's toolkits. The app works fully without it.

export const COMPOSIO_API_KEY_PREF_KEY = "composio-api-key";

/** Read the saved Composio API key, or an empty string if unset. */
export async function getComposioApiKey(target: ApiTarget): Promise<string> {
	return (await getPreference(target, COMPOSIO_API_KEY_PREF_KEY)) ?? "";
}

/** Write the Composio API key (raw, trimmed). An empty string clears it. */
export function setComposioApiKey(
	target: ApiTarget,
	key: string
): Promise<boolean> {
	return setPreference(target, COMPOSIO_API_KEY_PREF_KEY, key.trim());
}

// --- Cloud media provider keys (Replicate / Fal) ----------------------------
// BYOK credentials for cloud image/video generation. Stored in Core preferences;
// Core mirrors them into its in-process resolver and respawns the gateway so its
// `replicate` / `fal` media providers activate (key presence alone flips them on).

export const REPLICATE_API_KEY_PREF_KEY = "replicate-api-key";
export const FAL_API_KEY_PREF_KEY = "fal-api-key";

/** Read the saved Replicate API token, or an empty string if unset. */
export async function getReplicateApiKey(target: ApiTarget): Promise<string> {
	return (await getPreference(target, REPLICATE_API_KEY_PREF_KEY)) ?? "";
}

/** Write the Replicate API token (raw, trimmed). An empty string clears it. */
export function setReplicateApiKey(
	target: ApiTarget,
	key: string
): Promise<boolean> {
	return setPreference(target, REPLICATE_API_KEY_PREF_KEY, key.trim());
}

/** Read the saved Fal API key, or an empty string if unset. */
export async function getFalApiKey(target: ApiTarget): Promise<string> {
	return (await getPreference(target, FAL_API_KEY_PREF_KEY)) ?? "";
}

/** Write the Fal API key (raw, trimmed). An empty string clears it. */
export function setFalApiKey(target: ApiTarget, key: string): Promise<boolean> {
	return setPreference(target, FAL_API_KEY_PREF_KEY, key.trim());
}

// --- Claude Code gateway routing --------------------------------------------
// Opt-in: route Claude Code's egress through the Ryu gateway's transparent
// passthrough proxy (firewall/DLP/audit) while forwarding the user's OWN Pro/Max
// subscription auth upstream unchanged. Core injects `ANTHROPIC_BASE_URL` at
// spawn only when this is on; it never sets an API key (that would flip Claude
// Code off the subscription). Stored raw (a bare boolean string) under a key Core
// reads on startup and on change (`claude-gateway-routing`). Off by default since
// it changes how the subscription credential flows.

export const CLAUDE_GATEWAY_ROUTING_PREF_KEY = "claude-gateway-routing";

/** Default: off, so Claude Code keeps its native (ungoverned) egress until opt-in. */
export const DEFAULT_CLAUDE_GATEWAY_ROUTING = false;

/** Read the Claude Code gateway-routing toggle, defaulting to off. */
export async function getClaudeGatewayRouting(
	target: ApiTarget
): Promise<boolean> {
	const raw = await getPreference(target, CLAUDE_GATEWAY_ROUTING_PREF_KEY);
	if (raw === null) {
		return DEFAULT_CLAUDE_GATEWAY_ROUTING;
	}
	const value = raw.trim().toLowerCase();
	if (value === "true" || value === "1") {
		return true;
	}
	if (value === "false" || value === "0") {
		return false;
	}
	return DEFAULT_CLAUDE_GATEWAY_ROUTING;
}

/** Write the Claude Code gateway-routing toggle (as a bare boolean string). */
export function setClaudeGatewayRouting(
	target: ApiTarget,
	enabled: boolean
): Promise<boolean> {
	return setPreference(
		target,
		CLAUDE_GATEWAY_ROUTING_PREF_KEY,
		String(enabled)
	);
}

// --- Command-approval gate ---------------------------------------------------
// Armed by default: every ACP agent's native tool calls (Claude/Codex `Bash`,
// `Write`, `Edit`, …) are scanned through the gateway command-approval scanner
// at the ACP `request_permission` seam before they run. Backed by the
// `exec-approval-mode` Core preference, which Core seeds into
// `RYU_EXEC_APPROVAL_MODE` at startup (restart-to-apply). Stored as the mode
// string: `enforce` (on) / `off`. An UNSET pref means armed (Core's default-on
// posture — headless runs auto-approve permission requests, so the scan is
// what governs them); turning the toggle off stores an explicit `off`.

export const EXEC_APPROVAL_MODE_PREF_KEY = "exec-approval-mode";

/** Mode string persisted when the gate is enabled (any non-`off` value works). */
const EXEC_APPROVAL_ENABLED_MODE = "enforce";

/** Default: on — the scan is armed unless the user explicitly opts out. */
export const DEFAULT_EXEC_APPROVAL_ENABLED = true;

/** Read the command-approval gate toggle, defaulting to on (armed). */
export async function getExecApprovalEnabled(
	target: ApiTarget
): Promise<boolean> {
	const raw = await getPreference(target, EXEC_APPROVAL_MODE_PREF_KEY);
	if (raw === null) {
		return DEFAULT_EXEC_APPROVAL_ENABLED;
	}
	const value = raw.trim().toLowerCase();
	// Only an explicit `off` disables; empty/unset or any other stored mode is
	// armed (matches Core's `exec_approval_enabled` default-on semantics).
	return value !== "off";
}

/** Write the command-approval gate toggle (as a mode string: `enforce` / `off`). */
export function setExecApprovalEnabled(
	target: ApiTarget,
	enabled: boolean
): Promise<boolean> {
	return setPreference(
		target,
		EXEC_APPROVAL_MODE_PREF_KEY,
		enabled ? EXEC_APPROVAL_ENABLED_MODE : "off"
	);
}

// --- Codex gateway routing ---------------------------------------------------
// Opt-in: route Codex's ChatGPT-login (subscription) Responses egress through the
// Ryu gateway's transparent passthrough proxy (firewall/DLP/audit) while
// forwarding the user's OWN OAuth bearer + ChatGPT-Account-ID upstream unchanged.
// Core points Codex at an isolated CODEX_HOME whose config routes the
// subscription traffic at the gateway; it never injects an API key (that would
// flip Codex onto API-key billing). Stored raw (a bare boolean string) under a
// key Core reads on startup and on change (`codex-gateway-routing`). Off by
// default since it changes how the subscription credential flows.

export const CODEX_GATEWAY_ROUTING_PREF_KEY = "codex-gateway-routing";

/** Default: off, so Codex keeps its native subscription egress until opt-in. */
export const DEFAULT_CODEX_GATEWAY_ROUTING = false;

/** Read the Codex gateway-routing toggle, defaulting to off. */
export async function getCodexGatewayRouting(
	target: ApiTarget
): Promise<boolean> {
	const raw = await getPreference(target, CODEX_GATEWAY_ROUTING_PREF_KEY);
	if (raw === null) {
		return DEFAULT_CODEX_GATEWAY_ROUTING;
	}
	const value = raw.trim().toLowerCase();
	if (value === "true" || value === "1") {
		return true;
	}
	if (value === "false" || value === "0") {
		return false;
	}
	return DEFAULT_CODEX_GATEWAY_ROUTING;
}

/** Write the Codex gateway-routing toggle (as a bare boolean string). */
export function setCodexGatewayRouting(
	target: ApiTarget,
	enabled: boolean
): Promise<boolean> {
	return setPreference(target, CODEX_GATEWAY_ROUTING_PREF_KEY, String(enabled));
}

// --- Generic per-agent gateway routing ---------------------------------------
// The "point ANY agent at the Ryu gateway via the OpenAI base-URL swap" toggle,
// keyed per agent. Most useful for a BYO `acp-exec:` OpenAI-compatible agent: when
// on, Core injects OPENAI_BASE_URL + OPENAI_API_KEY into that agent's spawn so its
// model calls route through the gateway (firewall/budget/audit) instead of straight
// to a provider — no manual env wiring needed.
//
// Pi, Claude Code and Codex are NOT controlled here — they each have a dedicated,
// format-specific routing toggle (RyuPiConfig / Claude / Codex). All other agents
// share ONE preference holding a JSON object `{ "<agentId>": true }`. Read-merge-
// write keeps every agent's setting under the single key Core seeds at startup.

export const AGENT_GATEWAY_ROUTING_PREF_KEY = "agent-gateway-routing";

/** Default: off, so a BYO agent keeps its native (ungoverned) egress until opt-in. */
export const DEFAULT_AGENT_GATEWAY_ROUTING = false;

function parseAgentGatewayMap(raw: string | null): Record<string, boolean> {
	if (!raw || raw.trim() === "") {
		return {};
	}
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			const out: Record<string, boolean> = {};
			for (const [id, value] of Object.entries(
				parsed as Record<string, unknown>
			)) {
				out[id] = value === true || value === "true" || value === 1;
			}
			return out;
		}
	} catch {
		// Unparseable → treat as empty (everything off), never throw on the
		// settings path.
	}
	return {};
}

/** Read the full per-agent gateway-routing map from Core preferences. */
export async function getAgentGatewayRoutingMap(
	target: ApiTarget
): Promise<Record<string, boolean>> {
	const raw = await getPreference(target, AGENT_GATEWAY_ROUTING_PREF_KEY);
	return parseAgentGatewayMap(raw);
}

/** Read the gateway-routing toggle for a single agent id, defaulting to off. */
export async function getAgentGatewayRouting(
	target: ApiTarget,
	agentId: string
): Promise<boolean> {
	const map = await getAgentGatewayRoutingMap(target);
	return map[agentId] ?? DEFAULT_AGENT_GATEWAY_ROUTING;
}

/** Toggle gateway routing for a single agent id (read-merge-write the JSON map). */
export async function setAgentGatewayRouting(
	target: ApiTarget,
	agentId: string,
	enabled: boolean
): Promise<boolean> {
	const raw = await getPreference(target, AGENT_GATEWAY_ROUTING_PREF_KEY);
	const map = parseAgentGatewayMap(raw);
	map[agentId] = enabled;
	return setPreference(
		target,
		AGENT_GATEWAY_ROUTING_PREF_KEY,
		JSON.stringify(map)
	);
}

// --- Agent-auto routing (Plane B — pick which agent serves the turn) ---------
// The universal picker's "Auto" row (sentinel agent id `auto`) resolves the real
// agent per-turn in Core. This preference holds the rules Core resolves against —
// mirroring the gateway's `SmartRoutingConfig`, but each rule targets an AGENT id
// (not a model id) plus a `default_agent_id` fallback. Core reads this exact key
// and these exact snake_case fields, so the shape is a cross-track contract:
// changing a name here silently breaks resolution. See docs/routing-unification-spec.md §2.1.

export const AGENT_AUTO_ROUTING_PREF_KEY = "agent-auto-routing";

/** A single agent-auto rule: a plain-language condition + the agent to route to. */
export interface AgentAutoRule {
	/** Agent id to serve turns matching this rule. */
	agent_id: string;
	/** Natural-language condition, e.g. "writing or debugging code". */
	description: string;
}

/**
 * Agent-auto routing config (Plane B). Same strategy vocabulary as the gateway's
 * `SmartRoutingConfig`, but rule targets are agent ids. All fields are snake_case
 * because the blob is JSON.stringify'd verbatim and Core reads the exact keys.
 */
export interface AgentAutoRoutingConfig {
	/** Resolve once per conversation and reuse (guards against harness flapping). */
	cache_by_session: boolean;
	/** Cheap model used to classify each turn for the `llm` strategy. */
	classifier_model: string;
	/** Agent id used when no rule matches. */
	default_agent_id: string;
	/** Embedder for the `embedding` strategy. Empty ⇒ default local embedder. */
	embedding_model: string;
	/** Master switch. Off by default. */
	enabled: boolean;
	/** Ordered natural-language rules, each targeting an agent id. */
	rules: AgentAutoRule[];
	/** Min cosine for the `embedding` strategy to accept a rule. Default 0.35. */
	similarity_threshold: number;
	/** How the matching rule is chosen (`llm` | `embedding` | `keyword`). */
	strategy: RouteStrategy;
}

/** Default agent-auto config: off, LLM strategy, falls back to the flagship `ryu`. */
export const DEFAULT_AGENT_AUTO_ROUTING: AgentAutoRoutingConfig = {
	enabled: false,
	strategy: "llm",
	classifier_model: "",
	embedding_model: "",
	similarity_threshold: 0.35,
	rules: [],
	default_agent_id: DEFAULT_AGENT_ID,
	cache_by_session: true,
};

function coerceStrategy(value: unknown): RouteStrategy {
	return value === "embedding" || value === "keyword" ? value : "llm";
}

function coerceAgentAutoRules(value: unknown): AgentAutoRule[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const out: AgentAutoRule[] = [];
	for (const raw of value) {
		if (raw && typeof raw === "object") {
			const r = raw as Record<string, unknown>;
			const description =
				typeof r.description === "string" ? r.description : "";
			const agent_id = typeof r.agent_id === "string" ? r.agent_id : "";
			if (description && agent_id) {
				out.push({ description, agent_id });
			}
		}
	}
	return out;
}

/** Read the agent-auto routing config, falling back to {@link DEFAULT_AGENT_AUTO_ROUTING}. */
export async function getAgentAutoRouting(
	target: ApiTarget
): Promise<AgentAutoRoutingConfig> {
	const raw = await getPreference(target, AGENT_AUTO_ROUTING_PREF_KEY);
	if (!raw) {
		return DEFAULT_AGENT_AUTO_ROUTING;
	}
	try {
		const parsed = JSON.parse(raw) as Partial<AgentAutoRoutingConfig>;
		const threshold = Number(parsed.similarity_threshold);
		return {
			enabled: parsed.enabled === true,
			strategy: coerceStrategy(parsed.strategy),
			classifier_model:
				typeof parsed.classifier_model === "string"
					? parsed.classifier_model
					: "",
			embedding_model:
				typeof parsed.embedding_model === "string"
					? parsed.embedding_model
					: "",
			similarity_threshold: Number.isFinite(threshold) ? threshold : 0.35,
			rules: coerceAgentAutoRules(parsed.rules),
			default_agent_id:
				typeof parsed.default_agent_id === "string" &&
				parsed.default_agent_id.length > 0
					? parsed.default_agent_id
					: DEFAULT_AGENT_ID,
			cache_by_session: parsed.cache_by_session !== false,
		};
	} catch {
		return DEFAULT_AGENT_AUTO_ROUTING;
	}
}

/** Persist the full agent-auto routing config. Returns success. */
export function setAgentAutoRouting(
	target: ApiTarget,
	config: AgentAutoRoutingConfig
): Promise<boolean> {
	return setPreference(
		target,
		AGENT_AUTO_ROUTING_PREF_KEY,
		JSON.stringify(config)
	);
}

// --- Per-agent model-route override (Plane A, the "both" scope) --------------
// An agent can override the gateway's GLOBAL smart_routing with its own private
// SmartRoutingConfig. Core reads this map and, when forwarding an OpenAI-compat
// chat request for an agent that has an entry, injects it as the request body's
// `ryu_smart_route` field; the gateway builds an ephemeral router for that one
// request (see docs/routing-unification-spec.md §1). All agents share ONE
// preference holding a JSON object `{ "<agentId>": SmartRoutingConfig }`;
// read-merge-write keeps each agent's override under the single key.

export const AGENT_SMART_ROUTE_PREF_KEY = "agent-smart-route";

function parseAgentSmartRouteMap(
	raw: string | null
): Record<string, SmartRoutingConfig> {
	if (!raw || raw.trim() === "") {
		return {};
	}
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, SmartRoutingConfig>;
		}
	} catch {
		// Unparseable → treat as empty (no overrides), never throw on this path.
	}
	return {};
}

/** Read the per-agent model-route override for one agent id, or null when unset. */
export async function getAgentSmartRoute(
	target: ApiTarget,
	agentId: string
): Promise<SmartRoutingConfig | null> {
	const raw = await getPreference(target, AGENT_SMART_ROUTE_PREF_KEY);
	const map = parseAgentSmartRouteMap(raw);
	return map[agentId] ?? null;
}

/**
 * Set (or clear, when `config` is null) one agent's model-route override.
 * Read-merge-write the JSON map so other agents' overrides are preserved.
 */
export async function setAgentSmartRoute(
	target: ApiTarget,
	agentId: string,
	config: SmartRoutingConfig | null
): Promise<boolean> {
	const raw = await getPreference(target, AGENT_SMART_ROUTE_PREF_KEY);
	const map = parseAgentSmartRouteMap(raw);
	if (config === null) {
		delete map[agentId];
	} else {
		map[agentId] = config;
	}
	return setPreference(target, AGENT_SMART_ROUTE_PREF_KEY, JSON.stringify(map));
}

// --- Privacy / observability (P0 scaffold) ----------------------------------
// The canonical telemetry/support-access toggles from
// docs/observability-analytics-support-access.md §6, persisted in Core under the
// kebab keys below so every surface (and every later phase) reads ONE source of
// truth. Defaults follow the §6 table: closed-UI product analytics + crash
// reports are opt-out (ON by default), while the data-plane OTLP export and the
// local support-access channel are opt-in (OFF). NO collector/SDK is wired in
// this unit — these are the controls only, so collection can never precede
// consent. Core mirrors each to an env var (RYU_PRODUCT_ANALYTICS_ENABLED,
// OTEL_EXPORTER_OTLP_ENDPOINT, ...) for headless operation.

export const PRODUCT_ANALYTICS_ENABLED_PREF_KEY = "product-analytics-enabled";
export const COMMUNITY_STATS_ENABLED_PREF_KEY = "community-stats-enabled";
export const CRASH_REPORTS_ENABLED_PREF_KEY = "crash-reports-enabled";
export const DIAGNOSTICS_EXPORT_ENABLED_PREF_KEY = "diagnostics-export-enabled";
export const DIAGNOSTICS_OTLP_ENDPOINT_PREF_KEY = "diagnostics-otlp-endpoint";
export const SUPPORT_ACCESS_LOCAL_ENABLED_PREF_KEY =
	"support-access-local-enabled";
export const SUPPORT_ACCESS_LOCAL_EXPIRY_PREF_KEY =
	"support-access-local-expiry";

/** Defaults mirror Core + the §6 table (two opt-out, the rest opt-in/empty). */
export const DEFAULT_PRODUCT_ANALYTICS_ENABLED = true;
export const DEFAULT_COMMUNITY_STATS_ENABLED = true;
export const DEFAULT_CRASH_REPORTS_ENABLED = true;
export const DEFAULT_DIAGNOSTICS_EXPORT_ENABLED = false;
export const DEFAULT_SUPPORT_ACCESS_LOCAL_ENABLED = false;

/** Tolerant boolean parse: only explicit forms decide, else the default. */
function parsePrefBool(raw: string | null, fallback: boolean): boolean {
	if (raw === null) {
		return fallback;
	}
	const value = raw.trim().toLowerCase();
	if (value === "true" || value === "1" || value === "on" || value === "yes") {
		return true;
	}
	if (value === "false" || value === "0" || value === "off" || value === "no") {
		return false;
	}
	return fallback;
}

/** Read whether closed-UI product analytics is enabled (default ON, opt-out). */
export async function getProductAnalyticsEnabled(
	target: ApiTarget
): Promise<boolean> {
	const raw = await getPreference(target, PRODUCT_ANALYTICS_ENABLED_PREF_KEY);
	return parsePrefBool(raw, DEFAULT_PRODUCT_ANALYTICS_ENABLED);
}

/** Write the product-analytics toggle (as a bare boolean string). */
export function setProductAnalyticsEnabled(
	target: ApiTarget,
	enabled: boolean
): Promise<boolean> {
	return setPreference(
		target,
		PRODUCT_ANALYTICS_ENABLED_PREF_KEY,
		String(enabled)
	);
}

/** Read whether anonymous community stats sharing is enabled (default ON, opt-out). */
export async function getCommunityStatsEnabled(
	target: ApiTarget
): Promise<boolean> {
	const raw = await getPreference(target, COMMUNITY_STATS_ENABLED_PREF_KEY);
	return parsePrefBool(raw, DEFAULT_COMMUNITY_STATS_ENABLED);
}

/** Write the community-stats toggle (as a bare boolean string). */
export function setCommunityStatsEnabled(
	target: ApiTarget,
	enabled: boolean
): Promise<boolean> {
	return setPreference(
		target,
		COMMUNITY_STATS_ENABLED_PREF_KEY,
		String(enabled)
	);
}

/** Read whether crash reporting is enabled (default ON, opt-out, separate tier). */
export async function getCrashReportsEnabled(
	target: ApiTarget
): Promise<boolean> {
	const raw = await getPreference(target, CRASH_REPORTS_ENABLED_PREF_KEY);
	return parsePrefBool(raw, DEFAULT_CRASH_REPORTS_ENABLED);
}

/** Write the crash-reports toggle (as a bare boolean string). */
export function setCrashReportsEnabled(
	target: ApiTarget,
	enabled: boolean
): Promise<boolean> {
	return setPreference(target, CRASH_REPORTS_ENABLED_PREF_KEY, String(enabled));
}

/** Read whether data-plane OTLP export is enabled (default OFF, opt-in). */
export async function getDiagnosticsExportEnabled(
	target: ApiTarget
): Promise<boolean> {
	const raw = await getPreference(target, DIAGNOSTICS_EXPORT_ENABLED_PREF_KEY);
	return parsePrefBool(raw, DEFAULT_DIAGNOSTICS_EXPORT_ENABLED);
}

/** Write the diagnostics-export toggle (as a bare boolean string). */
export function setDiagnosticsExportEnabled(
	target: ApiTarget,
	enabled: boolean
): Promise<boolean> {
	return setPreference(
		target,
		DIAGNOSTICS_EXPORT_ENABLED_PREF_KEY,
		String(enabled)
	);
}

/** Read the OTLP export endpoint (empty = no destination configured). */
export async function getDiagnosticsOtlpEndpoint(
	target: ApiTarget
): Promise<string> {
	return (
		(await getPreference(target, DIAGNOSTICS_OTLP_ENDPOINT_PREF_KEY)) ?? ""
	);
}

/** Write the OTLP export endpoint (raw, trimmed). Empty clears it. */
export function setDiagnosticsOtlpEndpoint(
	target: ApiTarget,
	endpoint: string
): Promise<boolean> {
	return setPreference(
		target,
		DIAGNOSTICS_OTLP_ENDPOINT_PREF_KEY,
		endpoint.trim()
	);
}

/** Read whether the local Core support-access channel is granted (default OFF). */
export async function getSupportAccessLocalEnabled(
	target: ApiTarget
): Promise<boolean> {
	const raw = await getPreference(
		target,
		SUPPORT_ACCESS_LOCAL_ENABLED_PREF_KEY
	);
	return parsePrefBool(raw, DEFAULT_SUPPORT_ACCESS_LOCAL_ENABLED);
}

/** Write the local support-access toggle (as a bare boolean string). */
export function setSupportAccessLocalEnabled(
	target: ApiTarget,
	enabled: boolean
): Promise<boolean> {
	return setPreference(
		target,
		SUPPORT_ACCESS_LOCAL_ENABLED_PREF_KEY,
		String(enabled)
	);
}

/** Read the local support-access hard expiry (unix ms; 0 = no expiry set). */
export async function getSupportAccessLocalExpiry(
	target: ApiTarget
): Promise<number> {
	const raw = await getPreference(target, SUPPORT_ACCESS_LOCAL_EXPIRY_PREF_KEY);
	if (raw === null) {
		return 0;
	}
	const value = Number(raw.trim());
	return Number.isFinite(value) ? value : 0;
}

/** Write the local support-access hard expiry (unix ms). */
export function setSupportAccessLocalExpiry(
	target: ApiTarget,
	expiryMs: number
): Promise<boolean> {
	return setPreference(
		target,
		SUPPORT_ACCESS_LOCAL_EXPIRY_PREF_KEY,
		String(Math.max(0, Math.round(expiryMs)))
	);
}

// --- Node entitlement (hard paywall → Core automation gate) -----------------
// The desktop hard paywall (epic #496) resolves an access verdict at app entry.
// A Core node also runs autonomous automations (scheduled monitors, quests,
// workflows, agent prompts) independently of the UI, so it must know whether the
// user is still entitled — otherwise a paywalled user's automations keep
// spending managed inference in the background. The desktop pushes the resolved
// state here on every verdict change; Core reads it on startup + on change and
// its scheduler pauses firing while inactive. Stored raw (a bare boolean string)
// under a key matching Core's `entitlement::ENTITLEMENT_ACTIVE_PREF_KEY`.
// Default-ON in Core when unset (headless / OSS Core / still-entitled desktop).

export const ENTITLEMENT_ACTIVE_PREF_KEY = "entitlement-active";

/** Push whether the node is entitled to run autonomous automations. */
export function setEntitlementActive(
	target: ApiTarget,
	active: boolean
): Promise<boolean> {
	return setPreference(target, ENTITLEMENT_ACTIVE_PREF_KEY, String(active));
}

// --- Default sandbox run budget ---------------------------------------------
// The per-run execution cap Core hands the gateway's sandbox meter as
// `per_run_budget_micro_usd` when it starts a sandboxed run: once a run's accrued
// (marked-up) cost reaches this, the gateway returns a kill verdict and Core tears
// the workspace down. This is a "what runs" execution cap, so it lives as a Core
// NODE preference (single source of truth), NOT in control-plane org billing. The
// desktop writes it here; Core reads it per run. Stored as JSON (a bare u64 number
// of micro-USD); 0 = no per-run cap.

export const SANDBOX_DEFAULT_RUN_BUDGET_PREF_KEY =
	"sandbox-default-run-budget-micro-usd";

/** Read the default per-run sandbox budget in micro-USD; 0 (no cap) when unset. */
export async function getSandboxDefaultRunBudgetMicroUsd(
	target: ApiTarget
): Promise<number> {
	const raw = await getPreference(target, SANDBOX_DEFAULT_RUN_BUDGET_PREF_KEY);
	if (raw === null) {
		return 0;
	}
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (typeof parsed === "number" && Number.isFinite(parsed) && parsed >= 0) {
			return Math.round(parsed);
		}
	} catch {
		// Corrupt value → treat as no cap rather than throwing on the settings path.
	}
	return 0;
}

/** Write the default per-run sandbox budget (micro-USD, JSON-encoded u64). */
export function setSandboxDefaultRunBudgetMicroUsd(
	target: ApiTarget,
	microUsd: number
): Promise<boolean> {
	const value = Math.max(0, Math.round(microUsd));
	return setPreference(
		target,
		SANDBOX_DEFAULT_RUN_BUDGET_PREF_KEY,
		JSON.stringify(value)
	);
}

// --- Cross-device sync (M10) ------------------------------------------------
// The master switch for Core's cloud sync loop (`apps/core/src/server/sync.rs`).
// Core spawns the loop unconditionally at startup and re-reads THIS pref on every
// tick, so flipping it takes effect on the next tick — no restart.
//
// TWO load-bearing details:
//  1. The value is a BARE boolean string. Core matches it EXACTLY
//     (`matches!(pref.as_deref(), Some("true"))`), so a JSON-wrapped `"\"true\""`
//     would silently never enable sync. Always write `String(enabled)`.
//  2. Core also honours the `RYU_SYNC_ENABLED` env override, which WINS over this
//     pref. The UI cannot see that env var, so an OFF switch does not prove sync
//     is off on a node that sets it.
//
// The loop additionally needs Core to hold an auth token (it no-ops as
// `Unauthenticated` when signed out) — surfaced in the Settings copy.

export const CLOUD_SYNC_PREF_KEY = "cloud-sync-enabled";

/** Default: off. Nothing leaves the device until the user opts in. */
export const DEFAULT_CLOUD_SYNC = false;

/** Read whether Core's cross-device sync loop is enabled. Defaults to OFF. */
export async function getCloudSyncEnabled(target: ApiTarget): Promise<boolean> {
	const raw = await getPreference(target, CLOUD_SYNC_PREF_KEY);
	return parseBoolPreference(raw, DEFAULT_CLOUD_SYNC);
}

/** Write the cross-device sync flag as the BARE string Core matches on. */
export function setCloudSyncEnabled(
	target: ApiTarget,
	enabled: boolean
): Promise<boolean> {
	return setPreference(target, CLOUD_SYNC_PREF_KEY, String(enabled));
}

export async function getThemePrefs(
	target: ApiTarget
): Promise<ThemePrefs | null> {
	const raw = await getPreference(target, THEME_PREF_KEY);
	if (!raw) {
		return null;
	}
	try {
		return JSON.parse(raw) as ThemePrefs;
	} catch {
		return null;
	}
}

export function setThemePrefs(
	target: ApiTarget,
	prefs: ThemePrefs
): Promise<boolean> {
	return setPreference(target, THEME_PREF_KEY, JSON.stringify(prefs));
}
