// Part of the Island IPC type contract; `./ipc.ts` re-exports it, so import
// from there. Type-only: the sandboxed preload loads `./ipc.ts` at runtime.

import type { IslandAttachDialogLabels } from "./attach-dialog.ts";
import type { IslandWinApi } from "./ipc.ts";
import type {
	AcpConfigResult,
	AgentsResult,
	AvailabilityResult,
	ConversationsResult,
	CoreChatStreamHandle,
	CoreChatStreamRequest,
	CoreCompletionsRequest,
	CoreCompletionsResult,
	CoreSpeakRequest,
	CoreSpeakResult,
	CoreStreamEndEvent,
	CoreStreamPartEvent,
	CoreToolCallRequest,
	CoreToolCallResult,
	CoreTranscribeOptions,
	CoreTranscribeResult,
	DictationSubmitResult,
	EngineModelsResult,
	IslandAttachment,
	LanguagePacksResult,
	SidecarStartResult,
	SidecarStatusResult,
} from "./ipc-core.ts";
import type { IslandCatalogApi, IslandPluginsApi } from "./ipc-plugins.ts";
import type {
	CaptureControlResult,
	CaptureControlUpdate,
	ConsentPatch,
	ConsentState,
	FeedbackRequest,
	FeedbackResult,
	IslandMeetingsApi,
	IslandQuestsApi,
	IslandSettings,
	IslandSettingsPatch,
	IslandSuggestionsApi,
	ShadowContextResult,
	ShadowProactiveInboxResult,
	ShadowProactiveResult,
} from "./ipc-services.ts";
import type { NotchGeometry } from "./notch.ts";
import type { IslandSurfaceHostApi } from "./screen-surface.ts";

// ── Renderer-facing API surface (window.island) ──────────────────────────────

/** Core service methods exposed to the renderer. */
export interface IslandCoreApi {
	/** Abort an in-flight stream by id. */
	abortStream(streamId: string): Promise<void>;
	/** Fetch an agent's advertised ACP session config. Never rejects. */
	acpConfig(agentId: string): Promise<AcpConfigResult>;
	/** List installed agents for the command palette. Never rejects. */
	agents(): Promise<AgentsResult>;
	/** Invoke an MCP tool. Never rejects. */
	callTool(req: CoreToolCallRequest): Promise<CoreToolCallResult>;
	/**
	 * Start a streamed chat run. Parts arrive on the `core:streamPart` event and
	 * a terminal `core:streamEnd` event fires when the stream closes. Returns a
	 * handle whose `streamId` keys both events and `abortStream`.
	 */
	chatStream(req: CoreChatStreamRequest): Promise<CoreChatStreamHandle>;
	/** Non-streaming completion (suggestion engine). Never rejects. */
	completions(req: CoreCompletionsRequest): Promise<CoreCompletionsResult>;
	/** List recent conversations for the command palette. Never rejects. */
	conversations(): Promise<ConversationsResult>;
	/** Per-engine chat model catalog from Core. Never rejects. */
	engineModels(): Promise<EngineModelsResult>;
	/** Probe `GET /api/health`. Never rejects. */
	health(): Promise<AvailabilityResult>;
	/** Subscribe to stream-end events. Returns an unsubscribe function. */
	onStreamEnd(listener: (event: CoreStreamEndEvent) => void): () => void;
	/** Subscribe to streamed parts. Returns an unsubscribe function. */
	onStreamPart(listener: (event: CoreStreamPartEvent) => void): () => void;
	/** Start a named sidecar. Never rejects. */
	sidecarStart(name: string): Promise<SidecarStartResult>;
	/** Read sidecar statuses. Never rejects. */
	sidecarStatus(): Promise<SidecarStatusResult>;
	/** Transcribe captured WAV audio with the given engine. Never rejects. An
	 *  empty engine lets Core choose its default. */
	transcribe(
		audio: ArrayBuffer,
		engine: string,
		options?: CoreTranscribeOptions
	): Promise<CoreTranscribeResult>;
}

/**
 * Voice-input methods exposed to the renderer (`window.island.voice`). The value
 * is the raw JSON string of the shared `voice-input` blob persisted in Core
 * (`VoiceInputPrefs`); the renderer parses it with `shared/voice.ts`. `onToggle`
 * fires when the global push-to-talk shortcut is pressed (main → renderer).
 */
/**
 * Direction the Tab key cycles the routed agent while recording: `1` forward
 * (Tab), `-1` backward (Shift+Tab). The main process reports these off its global
 * key hook; the renderer advances the selected agent and persists the choice.
 */
export type VoiceCycleDirection = 1 | -1;

export interface IslandVoiceApi {
	/** Read the current voice-input blob (raw JSON), or `null` if unset. */
	get(): Promise<string | null>;
	/** Subscribe to live voice-input setting changes (raw JSON). */
	onChanged(listener: (value: string) => void): () => void;
	/**
	 * Subscribe to a Tab-cycle signal (agent switching while recording). The
	 * payload is the direction; the renderer rotates the routed agent and shows it
	 * on the recording pill. Returns an unsubscribe.
	 */
	onCycleAgent(listener: (direction: VoiceCycleDirection) => void): () => void;
	/**
	 * Subscribe to a push-to-talk *start* signal (hold-to-talk key-down). Returns
	 * an unsubscribe. Only fired in `"push-to-talk"` mode; toggle mode uses
	 * {@link onToggle} instead.
	 */
	onStart(listener: () => void): () => void;
	/**
	 * Subscribe to a push-to-talk *stop* signal (hold-to-talk key release, seen via
	 * the main-process key hook). Returns an unsubscribe.
	 */
	onStop(listener: () => void): () => void;
	/** Subscribe to push-to-talk shortcut presses (toggle mode). Returns an unsubscribe. */
	onToggle(listener: () => void): () => void;
	/**
	 * Report whether capture is currently active, so the main process can arm its
	 * global key hook (hold-to-talk release + Tab agent-cycling) only while
	 * recording. Fire-and-forget.
	 */
	setRecording(active: boolean): void;
	/**
	 * The Core node target (base URL + token) for opening the realtime voice-mode
	 * WebSocket directly from the renderer. Distinct from push-to-talk: voice mode
	 * is the continuous `/api/voice/ws` session (see `use-voice-mode.ts`).
	 */
	target(): Promise<VoiceTarget>;
}

/** Core node target the renderer needs to open the voice-mode WebSocket. */
export interface VoiceTarget {
	token: string | null;
	url: string;
}

/**
 * System-wide dictation methods exposed to the renderer (`window.island.dictation`).
 * Distinct from {@link IslandVoiceApi}: dictation types the transcript into the
 * focused native app rather than into the island chat, on its own global shortcut.
 * Agent-ask uses the same capture path with `task: "ask"` so the main process runs
 * an agent and pastes the answer. The renderer only captures audio; `submit` hands
 * the WAV to the main process.
 */
export interface IslandDictationApi {
	/** Read the current dictation blob (raw JSON), or `null` if unset. */
	get(): Promise<string | null>;
	/** Subscribe to live dictation setting changes (raw JSON). Returns unsubscribe. */
	onChanged(listener: (value: string) => void): () => void;
	/** Subscribe to a push-to-talk *start* signal (hold-to-talk key-down). */
	onStart(listener: (task: "transcribe" | "ask") => void): () => void;
	/** Subscribe to a push-to-talk *stop* signal (hold-to-talk key release). */
	onStop(listener: () => void): () => void;
	/** Subscribe to dictation shortcut presses (toggle mode). Returns unsubscribe. */
	onToggle(listener: (task: "transcribe" | "ask") => void): () => void;
	/**
	 * Report whether capture is active so the main process arms its global key hook
	 * (hold-to-talk release) only while recording. Pass `task` so agent-ask uses its
	 * own hold channel. Fire-and-forget.
	 */
	setRecording(active: boolean, task?: "transcribe" | "ask"): void;
	/**
	 * Hand captured 16 kHz mono WAV to the main process for transcription /
	 * agent-ask and insertion into the focused app. Never rejects.
	 */
	submit(
		audio: ArrayBuffer,
		task?: "transcribe" | "ask"
	): Promise<DictationSubmitResult>;
}

/**
 * Agent-routing methods exposed to the renderer (`window.island.agents`). The
 * value is the raw JSON string of the shared `island-agents` blob persisted in
 * Core (`IslandAgentPrefs`); the renderer parses it with `shared/agents.ts` to
 * pick which agent its chat routes to.
 */
export interface IslandAgentsApi {
	/** Read the current agent-routing blob (raw JSON), or `null` if unset. */
	get(): Promise<string | null>;
	/** Subscribe to live agent-routing changes (raw JSON). Returns an unsubscribe. */
	onChanged(listener: (value: string) => void): () => void;
	/**
	 * Persist the agent-routing blob (raw JSON of `IslandAgentPrefs`). Used when the
	 * user Tab-cycles the routed agent while recording so the pick sticks as the new
	 * default. Never rejects.
	 */
	set(raw: string): Promise<void>;
}

/**
 * Shared keyboard-shortcut overrides (`window.island.keybindings`). Raw JSON of
 * the desktop `keybindings` preference map; the renderer resolves composer
 * defaults via `@ryu/blocks/composer/composer-shortcuts`.
 */
export interface IslandKeybindingsApi {
	/** Read the current overrides blob (raw JSON), or `null` if unset. */
	get(): Promise<string | null>;
	/** Subscribe to live keybinding changes (raw JSON). Returns an unsubscribe. */
	onChanged(listener: (value: string) => void): () => void;
}

/**
 * Text-to-speech methods exposed to the renderer (`window.island.tts`). `get`
 * returns the raw JSON of the shared `island-tts` blob (`IslandTtsPrefs`, parsed
 * by `shared/tts.ts`); `speak` synthesizes a reply through Core and returns the
 * WAV bytes for the renderer to play. Never rejects to the renderer.
 */
export interface IslandTtsApi {
	/** Read the current TTS blob (raw JSON), or `null` if unset. */
	get(): Promise<string | null>;
	/** Subscribe to live TTS setting changes (raw JSON). Returns an unsubscribe. */
	onChanged(listener: (value: string) => void): () => void;
	/** Synthesize speech for `text`; returns playable WAV bytes. Never rejects. */
	speak(req: CoreSpeakRequest): Promise<CoreSpeakResult>;
}

/** Shadow service methods exposed to the renderer. */
export interface IslandShadowApi {
	getCaptureControl(): Promise<CaptureControlResult>;
	getCurrentContext(): Promise<ShadowContextResult>;
	getProactive(): Promise<ShadowProactiveResult>;
	getProactiveInbox(): Promise<ShadowProactiveInboxResult>;
	getSpeechHistory(
		input: import("@ryuhq/core-client/shadow").SpeechHistoryInput
	): Promise<import("@ryuhq/core-client/shadow").SpeechHistory>;
	postFeedback(req: FeedbackRequest): Promise<FeedbackResult>;
	setCaptureControl(
		update: CaptureControlUpdate
	): Promise<CaptureControlResult>;
}

/** Consent + privacy methods exposed to the renderer. */
export interface IslandConsentApi {
	/** Read the current per-capability consent state. */
	get(): Promise<ConsentState>;
	/** Subscribe to consent changes (e.g. tray-driven). Returns an unsubscribe. */
	onChanged(listener: (state: ConsentState) => void): () => void;
	/** Grant or decline one or more capabilities; returns the merged state. */
	set(patch: ConsentPatch): Promise<ConsentState>;
}

/** Settings methods exposed to the renderer. */
export interface IslandSettingsApi {
	/** Read the merged settings (endpoints + engine tunables). */
	get(): Promise<IslandSettings>;
	/** Persist a settings patch; returns the merged settings. */
	set(patch: IslandSettingsPatch): Promise<IslandSettings>;
}

/**
 * Theme-sync methods exposed to the renderer. The value is the raw JSON string
 * of the shared theme blob persisted in Core (`@ryu/ui`'s `ThemePrefs`). The
 * main process forwards it untouched; the renderer parses + applies it with
 * `@ryu/ui/theme` so the island matches the desktop's preset exactly.
 */
export interface IslandThemeApi {
	/** Read the current theme blob (raw JSON), or `null` if unset/unreachable. */
	get(): Promise<string | null>;
	/** Subscribe to live theme changes (raw JSON). Returns an unsubscribe. */
	onChanged(listener: (value: string) => void): () => void;
}

/**
 * Appearance methods exposed to the renderer. The value is an island-appearance
 * JSON blob naming the Background main built the live window in (which can lag
 * Core's value while a rebuild is pending). The renderer reads it on mount to
 * pick its shape styling and (in the acrylic window) to report its footprint; a
 * change in the *window mode* recreates + reloads the window, so a one-shot read
 * on mount always reflects the current mode.
 */
export interface IslandAppearanceApi {
	/** Read the built window's appearance blob (JSON); `null` is read as the default. */
	get(): Promise<string | null>;
	notch(): Promise<NotchGeometry | null>;
}

/**
 * Payload for `window:cursorMove`: the global cursor position expressed relative
 * to the island window's content origin (CSS px, which equals DIP for the
 * frameless window). These map directly onto a DOM `MouseEvent`'s
 * `clientX`/`clientY`, so the renderer can replay the move to drive the logo's
 * gaze tracking even while the pointer is nowhere near the (small) window.
 */
export interface CursorPoint {
	x: number;
	y: number;
}

/**
 * Command-surface summon events exposed to the renderer (`window.island.command`).
 * `onOpen` fires when the global hotkey summons the command palette; `onBlur`
 * fires when the window loses focus so the renderer can dismiss the command
 * surface. Both are main → renderer signals with no payload.
 */
export interface IslandCommandApi {
	/** Subscribe to window-blur events. Returns an unsubscribe function. */
	onBlur(listener: () => void): () => void;
	/** Subscribe to command-palette summon events. Returns an unsubscribe. */
	onOpen(listener: () => void): () => void;
}

/** System methods exposed to the renderer (`window.island.system`). */
export interface IslandSystemApi {
	/**
	 * Open the OS image picker (parented to the island window), read each chosen
	 * file into a data URL, and return them, or an empty array if the user
	 * cancelled. The attach action stages these on the chat composer and sends
	 * them to Core as image file-parts. Never rejects. Pass `labels` translated:
	 * the main process has no translator and shows English without them.
	 */
	attachFiles(labels?: IslandAttachDialogLabels): Promise<IslandAttachment[]>;
	/**
	 * Open a URL in the user's default browser. The main process ignores anything
	 * that is not an `http(s)://` URL, so the renderer can pass a smart-bar
	 * navigate/search/bang target without re-validating the scheme. Never rejects.
	 */
	openExternal(url: string): Promise<void>;
}

/** Window visibility methods exposed to the renderer. */
export interface IslandWindowApi {
	/**
	 * Subscribe to global cursor moves (window-relative coords) so the island's
	 * eyes can track the pointer across the entire screen, not just over the
	 * window. Returns an unsubscribe function.
	 */
	onCursorMove(listener: (point: CursorPoint) => void): () => void;
	/** Subscribe to show/hide changes (tray + hotkey driven). */
	onVisibilityChanged(listener: (visible: boolean) => void): () => void;
	/** Toggle the island window's visibility. */
	toggle(): void;
}

// ── Auto-update (electron-updater) ───────────────────────────────────────────

/**
 * Update lifecycle state, mirrored from the main process so a panel that mounts
 * after an update was already downloaded still shows the "Restart to update"
 * affordance (the `update:downloaded` event likely fired while it was closed).
 */
export interface UpdateState {
	/** True once electron-updater reported an update is available. */
	available: boolean;
	/** True once an update finished downloading and is ready to install. */
	downloaded: boolean;
	/** The version of the available/downloaded update, when known. */
	version: string | null;
}

/** Auto-update methods exposed to the renderer (`window.island.update`). */
export interface IslandUpdateApi {
	/** Read the shared `auto-updates` Core pref (`{enabled}`); default enabled. */
	getAutoUpdate(): Promise<boolean>;
	/** Read the current update lifecycle state (for a fresh panel mount). */
	getState(): Promise<UpdateState>;
	/** Read the running app version (`app.getVersion()`, reliable when packaged). */
	getVersion(): Promise<string>;
	/** Subscribe to "update available" events. Returns an unsubscribe function. */
	onAvailable(listener: (state: UpdateState) => void): () => void;
	/** Subscribe to "update downloaded" events. Returns an unsubscribe function. */
	onDownloaded(listener: (state: UpdateState) => void): () => void;
	/** Quit and install a downloaded update (no-op in dev / when not packaged). */
	quitAndInstall(): void;
	/** Write the shared `auto-updates` Core pref; returns the persisted value. */
	setAutoUpdate(enabled: boolean): Promise<boolean>;
}

// The API surface exposed to the renderer via the preload bridge
// (`window.island`). U1 owns `win.*` (click-through/drag); U2 adds `core.*` and
// `shadow.*`; U6 adds `consent.*`, `settings.*`, and `window.*`.
export interface IslandApi {
	agents: IslandAgentsApi;
	appearance: IslandAppearanceApi;
	catalog: IslandCatalogApi;
	command: IslandCommandApi;
	consent: IslandConsentApi;
	core: IslandCoreApi;
	dictation: IslandDictationApi;
	keybindings: IslandKeybindingsApi;
	languagePacks: {
		get(): Promise<LanguagePacksResult>;
	};
	meetings: IslandMeetingsApi;
	plugins: IslandPluginsApi;
	quests: IslandQuestsApi;
	settings: IslandSettingsApi;
	shadow: IslandShadowApi;
	suggestions: IslandSuggestionsApi;
	/** Drive the on-screen generative UI window (`shared/screen-surface.ts`). */
	surface: IslandSurfaceHostApi;
	system: IslandSystemApi;
	theme: IslandThemeApi;
	tts: IslandTtsApi;
	update: IslandUpdateApi;
	version: string;
	voice: IslandVoiceApi;
	win: IslandWinApi;
	window: IslandWindowApi;
}
