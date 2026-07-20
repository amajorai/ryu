// Shared IPC type contract between the Electron main process and the renderer.
//
// U1 introduces the window-control channels (`win:*`) used by the morphing
// island shell: click-through capture toggling and pointer-based dragging.
//
// U2 adds Core (:7980) and Shadow (:3030) service channels. All HTTP to Core and
// Shadow runs in the MAIN process because Core's CORS allowlist excludes Electron
// origins (apps/core/src/server/mod.rs). The renderer reaches these services only
// through the typed `window.island` bridge exposed by the preload script. This
// file is the single source of truth for the channel names and payload shapes on
// each side.

import type { ViewContribution } from "@ryu/app-host/views";

// ── Window control (U1) ──────────────────────────────────────────────────────

/** IPC channel names for window control. Renderer -> main, all fire-and-forget. */
export const WIN_CHANNELS = {
	/**
	 * Toggle whether the window captures mouse events. When `false` the window is
	 * click-through (`setIgnoreMouseEvents(true, { forward: true })`) so clicks
	 * outside the island shape reach the apps underneath.
	 */
	setMouseCapture: "win:setMouseCapture",
	/**
	 * Begin a drag gesture: main shows the snap-zone overlay for the active
	 * display. Sent on the first real pointer move so a plain click never snaps.
	 */
	dragStart: "win:dragStart",
	/** Move the window by a pointer delta (manual drag of the pill region). */
	moveBy: "win:moveBy",
	/** Snap to the nearest zone, persist, and hide the overlay when a drag ends. */
	dragEnd: "win:dragEnd",
	/**
	 * Resize the window to wrap the visible island footprint, anchored at its
	 * top-center. Only acted on in the `acrylic` appearance, where the window is
	 * the island (a native OS material fills the whole window rectangle); the
	 * `translucent` window stays at its fixed oversized panel size.
	 */
	setContentSize: "win:setContentSize",
} as const;

/** Payload for `win:setMouseCapture`. */
export interface SetMouseCapturePayload {
	/** `true` -> capture clicks on the window; `false` -> click-through. */
	capture: boolean;
}

/**
 * Payload for `win:dragStart`: the visible island shape's bounds relative to the
 * window's content origin (CSS px, which equals DIP for the frameless window).
 * Main combines these with the window position so snapping aligns the *visible*
 * pill to a zone, not the oversized transparent window around it.
 */
export interface DragStartPayload {
	height: number;
	width: number;
	x: number;
	y: number;
}

/** Payload for `win:moveBy`: a relative pixel delta from the drag pointer move. */
export interface MoveByPayload {
	dx: number;
	dy: number;
}

/** Payload for `win:setContentSize`: the visible island footprint in CSS px. */
export interface ContentSizePayload {
	/**
	 * Whether this footprint is the expanded panel. The main process anchors an
	 * expanded panel to the resting island and keeps it on-screen (flips upward at
	 * the bottom edge, clamps at the sides), then restores the resting position on
	 * collapse.
	 */
	expanded: boolean;
	height: number;
	width: number;
}

// The window-control API exposed to the renderer (`window.island.win`).
export interface IslandWinApi {
	/** Signal drag completion so main snaps to a zone + persists the position. */
	dragEnd(): void;
	/** Signal drag start (with the island's rect) so main shows the snap overlay. */
	dragStart(rect: DragStartPayload): void;
	/** Move the window by a relative delta during a manual drag. */
	moveBy(dx: number, dy: number): void;
	/**
	 * Report the visible island footprint (and whether it is the expanded panel)
	 * so the main process can keep the island on-screen: the material window is
	 * resized to the footprint, and an expanded panel in either appearance is
	 * anchored to the resting island and clamped/flipped to stay on the display.
	 */
	setContentSize(width: number, height: number, expanded: boolean): void;
	/** Enable/disable mouse capture on the window (click-through toggle). */
	setMouseCapture(capture: boolean): void;
}

// ── Core: chat stream (AI SDK v6 UI Message Stream) ──────────────────────────

/**
 * An AI SDK v6 file part (image attachment). Core's chat-stream adapter reads
 * `parts` for any `type: "file"` with an `image/*` `mediaType` and forwards the
 * base64 from the data `url` to the model — the same shape the desktop composer
 * sends. Non-image files are not wired (the default island agent has no file
 * tools), so the attach action only stages images.
 */
export interface CoreFilePart {
	filename?: string;
	/** MIME type, e.g. `image/png`. */
	mediaType: string;
	type: "file";
	/** A `data:<mime>;base64,...` URL carrying the image bytes. */
	url: string;
}

/** A single chat message in the AI SDK UIMessage shape Core accepts. */
export interface CoreChatMessage {
	/** Plain text content. Core also accepts a `parts` array but text is enough. */
	content: string;
	/** Optional image attachments for this turn (multimodal user messages). */
	parts?: CoreFilePart[];
	role: "user" | "assistant" | "system";
}

/**
 * An image the user attached via the island's attach action. Read into a data
 * URL in the main process so the renderer can both preview it (chip thumbnail)
 * and send it to Core as a {@link CoreFilePart} without touching the filesystem.
 */
export interface IslandAttachment {
	/** `data:<mime>;base64,...` URL of the file bytes. */
	dataUrl: string;
	mimeType: string;
	/** Display name (basename). */
	name: string;
	/** Absolute source path (stable id + de-dupe key). */
	path: string;
}

/** Body for `POST /api/chat/stream` (subset of Core's `ChatStreamRequest`). */
export interface CoreChatStreamRequest {
	acp_config?: Record<string, string>;
	acp_mode?: string;
	acp_model?: string;
	agent_id?: string;
	/** True when this turn originates from the context companion (DLP path). */
	companion_source?: boolean;
	conversation_id?: string;
	/** Opt-in cross-session memory. Defaults to false (privacy by default). */
	enable_long_term?: boolean;
	messages: CoreChatMessage[];
	/**
	 * Whether Core should persist this turn to the conversation store. Core
	 * defaults to `true`; the proactive suggestion engine sets it `false` so each
	 * background suggestion does not leave an orphan "App: …" conversation behind.
	 */
	persist?: boolean;
	/**
	 * Opt-in per-turn plugin toggles Core's server-side turn-hooks read. The island
	 * surfaces `"io.ryu.double-check"`; Core reviews the answer only when it is true.
	 */
	plugin_flags?: Record<string, boolean>;
}

// AI SDK v6 UI Message Stream parts emitted by Core over SSE. Each `data:` line
// carries one JSON object discriminated by `type`. The parser (`parseSsePart`)
// decodes these; the main process forwards every part to the renderer as a
// `core:streamPart` event.

export interface StartPart {
	type: "start";
}
export interface TextStartPart {
	id: string;
	type: "text-start";
}
export interface TextDeltaPart {
	delta: string;
	id: string;
	type: "text-delta";
}
export interface TextEndPart {
	id: string;
	type: "text-end";
}
export interface ToolInputAvailablePart {
	dynamic?: boolean;
	input: unknown;
	toolCallId: string;
	toolName: string;
	type: "tool-input-available";
}
export interface ToolOutputAvailablePart {
	dynamic?: boolean;
	output: unknown;
	toolCallId: string;
	type: "tool-output-available";
}
export interface FinishPart {
	type: "finish";
}
export interface ErrorPart {
	errorText: string;
	type: "error";
}
/**
 * An out-of-band note from a Core server-side turn-hook (goal/proof/double-check).
 * Streamed as an EXTRA SSE frame in the same response — never assistant history —
 * so the island renders it as a distinct system note, not a chat bubble.
 */
export interface PluginNotePart {
	data: { text: string };
	type: "data-plugin_note";
}

/** Any unrecognized part still carries a string `type` discriminator. */
export interface OtherPart {
	type: string;
	[key: string]: unknown;
}

export type CoreStreamPart =
	| StartPart
	| TextStartPart
	| TextDeltaPart
	| TextEndPart
	| ToolInputAvailablePart
	| ToolOutputAvailablePart
	| FinishPart
	| ErrorPart
	| PluginNotePart
	| OtherPart;

/** Envelope the renderer receives for each streamed part. */
export interface CoreStreamPartEvent {
	part: CoreStreamPart;
	streamId: string;
}

/** Terminal envelope: the stream ended (cleanly, via abort, or with error). */
export interface CoreStreamEndEvent {
	/** Human-readable error message when `reason === "error"`. */
	error?: string;
	/** Reason the stream ended. `done` is the normal [DONE] terminator. */
	reason: "done" | "aborted" | "error";
	streamId: string;
}

/** Handle returned by `chatStream` so the renderer can abort the stream. */
export interface CoreChatStreamHandle {
	streamId: string;
}

// ── Core: non-streaming completions + tools + sidecars ───────────────────────

/** Result of a graceful health probe. Never rejects to the renderer. */
export interface AvailabilityResult {
	available: boolean;
	/** Why the service is unavailable (timeout, connection refused, …). */
	reason?: string;
}

/** Body for `POST /v1/chat/completions`. `model` omitted = local Gemma 4 E2B. */
export interface CoreCompletionsRequest {
	messages: CoreChatMessage[];
	model?: string;
}

/** Result of a non-streaming completion. */
export type CoreCompletionsResult =
	| { available: true; text: string }
	| { available: false; reason: string };

/** Body for `POST /api/mcp/tools/call`. */
export interface CoreToolCallRequest {
	/** Required by Core to resolve the per-agent allowlist. */
	agent_id: string;
	arguments: Record<string, unknown>;
	tool: string;
}

/** Result of an MCP tool call. */
export type CoreToolCallResult =
	| { available: true; ok: boolean; output?: unknown; error?: string }
	| { available: false; reason: string };

/** Body for `POST /api/voice/transcribe` (multipart, built in the main process). */
export interface CoreTranscribeRequest {
	/** 16 kHz mono WAV bytes captured in the renderer. */
	audio: ArrayBuffer;
	/** Transcription engine (`"whisper"` | `"parakeet"`), the `?engine=` value. */
	engine: string;
}

/** Result of a transcription request. Never rejects to the renderer. */
export type CoreTranscribeResult =
	| { available: true; text: string }
	| { available: false; reason: string };

/** Request for `POST /api/voice/speak` (text-to-speech), built in the main process. */
export interface CoreSpeakRequest {
	/** TTS engine id; omit (or `"outetts"`) for the built-in default. */
	engine?: string;
	/** Text to synthesize. */
	text: string;
	/** Voice id (engine-specific); omit for the engine's default voice. */
	voice?: string;
}

/** Result of a speak request. Carries the WAV bytes for the renderer to play. */
export type CoreSpeakResult =
	| { available: true; audio: ArrayBuffer; mime: string }
	| { available: false; reason: string };

/**
 * Result of a dictation submission: the renderer hands captured WAV to the main
 * process, which transcribes, optionally post-processes, and inserts the text
 * into the focused app. `ok` false carries a short reason the renderer can flash
 * on the recording pill (empty capture, engine not running, transcribe/insert
 * failure); `text` is the inserted text on success, for an optional confirmation.
 */
export type DictationSubmitResult =
	| { ok: true; text: string }
	| { ok: false; reason: string };

/** A single sidecar's status from `GET /api/sidecar/status`. */
export interface SidecarStatus {
	name: string;
	running: boolean;
}

/** Result of a sidecar status probe. */
export type SidecarStatusResult =
	| { available: true; sidecars: SidecarStatus[] }
	| { available: false; reason: string };

// ── Core: agents + conversations (command palette data) ──────────────────────
//
// The expanded island's command surface lists the installed agents and recent
// conversations as palette entries. Both are read in the main process (CORS) and
// degrade gracefully to an `{ available: false }` envelope.

/** One installed agent, as the command palette needs it. */
export interface CoreAgentSummary {
	/** Derived from registry built-ins that serialize `transport`. */
	builtIn?: boolean;
	description: string | null;
	engine: string | null;
	id: string;
	model: string | null;
	name: string;
	/** True for the flagship default (the locked `ryu` card). */
	recommended: boolean;
	transport: string | null;
}

/** Result of an agent list probe. */
export type AgentsResult =
	| { available: true; agents: CoreAgentSummary[] }
	| { available: false; reason: string };

import type { AcpConfig } from "./acp.ts";

/** Result of an ACP config probe for one agent. */
export type AcpConfigResult =
	| { available: true; config: AcpConfig }
	| { available: false; reason: string };

/** Per-engine chat model catalog from Core. */
export type EngineModelsResult =
	| { available: true; models: Record<string, { id: string; name: string }[]> }
	| { available: false; reason: string };

/** One recent conversation, as the command palette needs it. */
export interface CoreConversationSummary {
	id: string;
	title: string;
}

/** Result of a conversation list probe. */
export type ConversationsResult =
	| { available: true; conversations: CoreConversationSummary[] }
	| { available: false; reason: string };

/** Result of a sidecar start request. */
export type SidecarStartResult =
	| { available: true; success: boolean; error?: string }
	| { available: false; reason: string };

// ── Core: plugin (Ryu App / Companion) host ──────────────────────────────────
//
// The full-page Companion host mirrors the desktop's `PluginHostPanel`, but every
// Core HTTP call runs in the main process (CORS excludes Electron origins) and is
// reached over IPC. The renderer mounts `@ryu/app-host`'s sandboxed iframe and
// implements the privileged host services by delegating to these IPC methods.

/** A companion-surface descriptor contributed by an enabled plugin
 *  (`RunnableKind::Companion`), projected to the renderer. Mirrors the desktop
 *  `PluginCompanion`. `approvedGrants` is the GATEWAY-VALIDATED grant subset for
 *  the owning plugin (the only correct source for the host capability set);
 *  `hasUi` is true when the plugin carries a bundled UI. `pluginId` is the owning
 *  plugin's manifest id (the UI bundle + host invokes are keyed by it, NOT by the
 *  companion `id`). */
export interface PluginCompanion {
	approvedGrants: string[];
	hasUi: boolean;
	icon: string | null;
	id: string;
	label: string;
	name: string;
	pluginId: string;
	shortcut: string | null;
}

/** A declarative-view contribution as served by Core (`contributes.views[]`), tagged
 *  with its owning `plugin`. Shape-identical to the shared `@ryu/app-host/views`
 *  {@link ViewContribution} — the island renders it host-side with
 *  `@ryu/blocks/island`'s `IslandViewPanel` (the Raycast tier, island idiom), exactly
 *  as the desktop renders the SAME spec full-size. Mirrors the desktop `PluginView`. */
export type PluginView = ViewContribution;

/** Result of the enabled-plugin contributions probe
 *  (`GET /api/plugins/contributions`). Never rejects to the renderer. Carries both the
 *  companion surfaces (sandboxed-UI apps) and the declarative `views` (host-rendered). */
export type PluginContributionsResult =
	| { available: true; companions: PluginCompanion[]; views: PluginView[] }
	| { available: false; reason: string };

/** Result of a plugin UI-bundle fetch (`GET /api/plugins/:id/ui-bundle`). `code`
 *  is null when the plugin has no bundle / is not enabled (Core answers 404). */
export type PluginUiBundleResult =
	| { available: true; code: string | null }
	| { available: false; reason: string };

/** The closed error code the app host-bridge surfaces to a companion frame.
 *  Mirrors the desktop `PluginHostErrorCode`. */
export type PluginHostErrorCode =
	| "denied"
	| "not_found"
	| "over_budget"
	| "server_error"
	| "invalid_args";

/** Body for a one-shot host-bridge invoke (renderer → main). `method` is the
 *  DOTTED wire name Core maps to the bridge (`model.complete`/`agent.run`/
 *  `storage.*`); `args` is forwarded verbatim (already validated in `rpc.ts`). */
export interface PluginHostInvokeRequest {
	args: unknown;
	method: string;
	pluginId: string;
}

/** Discriminated result of a host-bridge invoke. `ok:false` carries the structured
 *  `{ code, message }` so the renderer transport can reconstruct a `PluginHostError`
 *  — `ipcMain.handle` cannot serialize a thrown error's `.code`, so we return it. */
export type PluginHostInvokeResult =
	| { ok: true; result: unknown }
	| { ok: false; code: PluginHostErrorCode; message: string };

/** Body for an authenticated Core HTTP call on behalf of a declarative view
 *  (renderer → main): the http tier of view actions + the view `source` fetch.
 *  `path` must be a Core-relative `/api/...` path (validated main-side too);
 *  `body` (when present) is JSON-serialized. The renderer templates paths/bodies
 *  BEFORE this hop (`@ryu/app-host/views` `renderActionHttp`). */
export interface PluginCoreHttpRequest {
	body?: unknown;
	method: string;
	path: string;
}

/** Discriminated result of a Core HTTP call for a declarative view. `data` is
 *  the parsed JSON body (or `null` when the response carries none). */
export type PluginCoreHttpResult =
	| { ok: true; status: number; data: unknown }
	| { ok: false; code: PluginHostErrorCode; message: string };

/** Body to start a streaming host-bridge `agent.run` (renderer → main). */
export interface PluginHostStreamStartRequest {
	input: unknown;
	pluginId: string;
}

/** Handle returned when a host stream starts; keys the chunk/end events + abort. */
export interface PluginHostStreamHandle {
	streamId: string;
}

/** A streamed reply-token chunk pushed from the main process during a host stream. */
export interface PluginHostStreamChunkEvent {
	delta: string;
	streamId: string;
}

/** Terminal event of a host stream. `error`/`code` are set only when `reason` is
 *  `"error"`. */
export interface PluginHostStreamEndEvent {
	code?: PluginHostErrorCode;
	error?: string;
	reason: "aborted" | "done" | "error";
	streamId: string;
}

/** Plugin-host methods exposed to the renderer (`window.island.plugins`). */
export interface IslandPluginsApi {
	/** Abort an in-flight host stream by id. */
	abortHostStream(streamId: string): Promise<void>;
	/** Enabled-plugin companion contributions. Never rejects. */
	contributions(): Promise<PluginContributionsResult>;
	/** Authenticated Core HTTP for a declarative view (http actions + `source`
	 *  fetch). Never rejects; failures come back as `ok:false`. */
	coreHttp(req: PluginCoreHttpRequest): Promise<PluginCoreHttpResult>;
	/** One-shot host-bridge invoke. Never rejects; failures come back as `ok:false`. */
	hostInvoke(req: PluginHostInvokeRequest): Promise<PluginHostInvokeResult>;
	/** Subscribe to host-stream reply chunks. Returns an unsubscribe function. */
	onHostStreamChunk(
		listener: (event: PluginHostStreamChunkEvent) => void
	): () => void;
	/** Subscribe to host-stream terminal events. Returns an unsubscribe function. */
	onHostStreamEnd(
		listener: (event: PluginHostStreamEndEvent) => void
	): () => void;
	/** Start a streaming host-bridge `agent.run`. Chunks arrive on the
	 *  `plugins:hostStreamChunk` event and a terminal `plugins:hostStreamEnd`
	 *  event fires when the stream closes. */
	startHostStream(
		req: PluginHostStreamStartRequest
	): Promise<PluginHostStreamHandle>;
	/** Fetch an enabled plugin's bundled UI code. Never rejects. */
	uiBundle(pluginId: string): Promise<PluginUiBundleResult>;
}

// ── Core: marketplace catalog (skills + MCP) ─────────────────────────────────
//
// A thin browse/install surface over Core's catalog endpoints. All HTTP runs in
// the main process (CORS); every method resolves to a result envelope and never
// rejects to the renderer. MCP installed-state is NOT carried by the catalog
// payload (Core hardcodes false), so it is derived in the main process by
// cross-referencing `GET /api/mcp/servers` (a card is installed iff its id is a
// registered server name).

/** Catalog kinds the marketplace can browse. */
export type CatalogKind = "model" | "skill" | "mcp" | "plugin";

/** One selectable catalog source. Mirrors Core's source descriptor. */
export interface CatalogSource {
	baseUrl: string | null;
	builtin: boolean;
	displayName: string;
	id: string;
}

/** The active source id plus every source for a kind. */
export type CatalogSourcesResult =
	| { available: true; active: string; sources: CatalogSource[] }
	| { available: false; reason: string };

/** A normalized marketplace row (skill or MCP server) for the renderer list. */
export interface CatalogItem {
	description: string | null;
	id: string;
	installed: boolean;
	name: string;
	/** A short secondary line (installs, transports, version, …). */
	subtitle: string | null;
}

/** Result of a catalog list query. */
export type CatalogListResult =
	| { available: true; items: CatalogItem[] }
	| { available: false; reason: string };

/** Result of a catalog install or source-select action. */
export type CatalogActionResult =
	| { available: true; ok: boolean; error?: string }
	| { available: false; reason: string };

/** Body for a catalog list query (renderer → main). */
export interface CatalogListRequest {
	kind: "skill" | "mcp";
	query: string;
}

/** Body for a catalog install (renderer → main). */
export interface CatalogInstallRequest {
	id: string;
	kind: "skill" | "mcp";
}

/** Body for selecting the active source of a kind (renderer → main). */
export interface CatalogSelectSourceRequest {
	id: string;
	kind: "skill" | "mcp";
}

/** Marketplace catalog methods exposed to the renderer (`window.island.catalog`). */
export interface IslandCatalogApi {
	/** Install a skill or MCP server. Never rejects. */
	install(req: CatalogInstallRequest): Promise<CatalogActionResult>;
	/** List the active source's catalog for a kind. Never rejects. */
	list(req: CatalogListRequest): Promise<CatalogListResult>;
	/** Select the active source for a kind. Never rejects. */
	selectSource(req: CatalogSelectSourceRequest): Promise<CatalogActionResult>;
	/** List the catalog sources for a kind. Never rejects. */
	sources(kind: "skill" | "mcp"): Promise<CatalogSourcesResult>;
}

// ── Shadow: context, suggestions, capture control ────────────────────────────

/** Context snapshot from Shadow's `GET /context/current`. */
export interface ShadowContext {
	app_name: string | null;
	capture_active: boolean;
	ocr_text: string | null;
	ocr_timestamp_us: number | null;
	paused: boolean;
	selected_text: string | null;
	timestamp_us: number | null;
	window_title: string | null;
}

/** Result of a Shadow context probe. */
export type ShadowContextResult =
	| { available: true; context: ShadowContext }
	| { available: false; reason: string };

/** Disposition assigned by Shadow's policy engine. */
export type SuggestionDisposition = "push_now" | "inbox_only" | "drop";

/** A proactive suggestion from Shadow at `GET /proactive`. */
export interface ProactiveSuggestion {
	body: string | null;
	confidence: number;
	created_at: number;
	disposition: SuggestionDisposition;
	id: string;
	metadata: Record<string, unknown>;
	suggestion_type: string;
	title: string;
}

/** Result of a proactive-suggestion probe. */
export type ShadowProactiveResult =
	| { available: true; suggestion: ProactiveSuggestion | null }
	| { available: false; reason: string };

/**
 * Result of a proactive-INBOX probe: every stored suggestion the policy engine
 * did not drop (`inbox_only` + `push_now`), newest first. The transient chip
 * only ever surfaces the top `push_now` one; this is how the user reviews the
 * rest that Shadow already persisted.
 */
export type ShadowProactiveInboxResult =
	| { available: true; suggestions: ProactiveSuggestion[] }
	| { available: false; reason: string };

/** Feedback kind sent to Shadow via `POST /api/feedback`. */
export type FeedbackKind = "thumbs_up" | "thumbs_down" | "snooze" | "dismiss";

/** Body for `POST /api/feedback`. */
export interface FeedbackRequest {
	kind: FeedbackKind;
	suggestion_type: string;
}

/** Result of posting feedback. */
export interface FeedbackResult {
	available: boolean;
	ok?: boolean;
	reason?: string;
}

/** Capture-control state from `GET /capture/control`. */
export interface CaptureControl {
	app_allowlist: string[];
	paused: boolean;
}

/** Body for `POST /capture/control`. All fields optional. */
export interface CaptureControlUpdate {
	app_allowlist?: string[];
	paused?: boolean;
}

/** Result of a capture-control read or write. */
export type CaptureControlResult =
	| { available: true; control: CaptureControl }
	| { available: false; reason: string };

// ── Suggestion engine (U3) ───────────────────────────────────────────────────

/** Where a surfaced suggestion came from. */
export type SuggestionSource = "local_model" | "shadow_proactive";

/** A suggestion surfaced to the renderer by the engine. */
export interface IslandSuggestion {
	/** Optional action hint: open chat or just dismiss. */
	action: "chat" | "dismiss";
	/** App the context belonged to when generated (for feedback + dedupe). */
	appName: string | null;
	/** Supporting detail. May be empty. */
	body: string;
	/** Model/Shadow confidence in [0, 1]. */
	confidence: number;
	/** Stable id (also used as the dedupe-aware identity for feedback). */
	id: string;
	/** Origin of the suggestion. */
	source: SuggestionSource;
	/** Shadow `suggestion_type` when sourced from `/proactive`; else "context". */
	suggestionType: string;
	/** Short headline. */
	title: string;
	/** Epoch milliseconds when emitted. */
	ts: number;
}

/** Lifecycle state of the engine, mirrored to the renderer. */
export interface SuggestionEngineStatus {
	/** Count of suggestions emitted this session. */
	emitted: number;
	/** Last context-poll outcome ("ok" | reason string) for diagnostics. */
	lastContextReason: string | null;
	/** True once `start()` has run and timers are active. */
	running: boolean;
}

/** Feedback the renderer sends back about a surfaced suggestion. */
export interface SuggestionFeedbackRequest {
	id: string;
	kind: FeedbackKind;
}

/** Result of routing feedback through to Shadow + the cooldown. */
export type SuggestionFeedbackResult =
	| { ok: true }
	| { ok: false; reason: string };

/** Renderer-facing suggestion API (`window.island.suggestions`). */
export interface IslandSuggestionsApi {
	/** Send accept/dismiss/snooze feedback for a surfaced suggestion. */
	feedback(req: SuggestionFeedbackRequest): Promise<SuggestionFeedbackResult>;
	/** Subscribe to a "cleared" event (engine stopped / consent revoked). */
	onCleared(listener: () => void): () => void;
	/** Subscribe to new suggestions. Returns an unsubscribe function. */
	onNew(listener: (suggestion: IslandSuggestion) => void): () => void;
	/** Start the engine (consent gate for U6 lives upstream of this). */
	start(): Promise<SuggestionEngineStatus>;
	/** Read the current engine status. */
	status(): Promise<SuggestionEngineStatus>;
	/** Stop the engine and clear timers + history. */
	stop(): Promise<SuggestionEngineStatus>;
}

// ── Meeting notes (auto-detection + recording) ───────────────────────────────
//
// Core owns the meeting brain (detection, capture orchestration, transcription,
// notes). The island is a thin surface: the main process subscribes to Core's
// `GET /api/meetings/stream` SSE and forwards events; on a `detected` event the
// renderer offers a "start notes?" chip that calls `meetings.start`. Audio
// capture is device-local (Shadow), never the island.

/** A meeting as the island needs it (a subset of Core's `Meeting`). */
export interface IslandMeeting {
	app?: string | null;
	id: string;
	status: string;
	title: string;
}

/** Live meeting events forwarded from Core's SSE stream (subset used here). */
export type IslandMeetingEvent =
	| { type: "detected"; app: string; title: string; detected_at: string }
	| { type: "started"; meeting: IslandMeeting }
	| { type: "segment"; segment: { meeting_id: string; text: string } }
	| { type: "status"; meeting_id: string; status: string }
	| { type: "finalized"; meeting: IslandMeeting };

/** Body for starting a meeting from the island. */
export interface IslandStartMeetingInput {
	app?: string;
	source?: "manual" | "auto";
	title?: string;
}

/** Result of a start/finalize action. Never rejects to the renderer. */
export type IslandMeetingResult =
	| { available: true; meeting: IslandMeeting }
	| { available: false; reason: string };

/** Meeting methods exposed to the renderer (`window.island.meetings`). */
export interface IslandMeetingsApi {
	/** Finalize a meeting (stop capture + generate notes). Never rejects. */
	finalize(id: string): Promise<IslandMeetingResult>;
	/** Subscribe to live meeting events. Returns an unsubscribe function. */
	onEvent(listener: (event: IslandMeetingEvent) => void): () => void;
	/** Start recording a meeting. Never rejects. */
	start(input?: IslandStartMeetingInput): Promise<IslandMeetingResult>;
}

// ── Quests (auto-detecting todo list) ────────────────────────────────────────
//
// Core owns the quest brain (it watches Shadow context and judges whether a task
// is done). The island is a thin surface: the main process subscribes to Core's
// `GET /api/quests/events` SSE and forwards events; on a `suggested` event the
// renderer offers a "looks done — mark it?" chip that confirms or rejects via
// `quests.accept` / `quests.dismiss`. The `suggested` event is consent-gated.

/** A quest as the island needs it (a subset of Core's `Quest`). */
export interface IslandQuest {
	id: string;
	status: string;
	title: string;
}

/** Live quest events forwarded from Core's SSE stream (subset used here). */
export type IslandQuestEvent =
	| {
			type: "suggested";
			quest: IslandQuest;
			confidence: number;
			reason: string;
	  }
	| { type: "completed"; quest: IslandQuest; auto: boolean }
	| { type: "updated"; quest: IslandQuest }
	| { type: "deleted"; id: string };

/** Result of an accept/dismiss action. Never rejects to the renderer. */
export type IslandQuestResult =
	| { available: true; quest: IslandQuest }
	| { available: false; reason: string };

/** Quest methods exposed to the renderer (`window.island.quests`). */
export interface IslandQuestsApi {
	/** Confirm a detected completion (mark the quest done). Never rejects. */
	accept(id: string): Promise<IslandQuestResult>;
	/** Reject the pending suggestion but keep the quest open. Never rejects. */
	dismiss(id: string): Promise<IslandQuestResult>;
	/** Subscribe to live quest events. Returns an unsubscribe function. */
	onEvent(listener: (event: IslandQuestEvent) => void): () => void;
}

// ── Consent + privacy (U6) ───────────────────────────────────────────────────

// Per-capability consent. `chat` defaults ON (the island is a chat surface);
// `contextRead` (screen/window capture via Shadow :3030) and `proactive` (the
// suggestion engine) are UNSET until the user answers the first-run consent
// card, so `null` means "ask". A HARD GATE in the main process blocks every
// request to Shadow while `contextRead` is not `true`, and the suggestion engine
// must consult `shouldRunEngine()` before starting.
export interface ConsentState {
	/** Chat with Core. Defaults to `true`. */
	chat: boolean;
	/** Screen/window context capture via Shadow. `null` = unanswered (ask). */
	contextRead: boolean | null;
	/** Proactive suggestion engine. `null` = unanswered (ask). */
	proactive: boolean | null;
}

/** A single capability the consent card can grant or decline. */
export type ConsentCapability = "chat" | "contextRead" | "proactive";

/** Patch for `consent:set`: any subset of capabilities. */
export interface ConsentPatch {
	chat?: boolean;
	contextRead?: boolean | null;
	proactive?: boolean | null;
}

/** Tunables the proactive engine reads. Persisted alongside service config. */
export interface EngineSettings {
	/** Minimum seconds between two pushed suggestions (cooldown). */
	cooldownSeconds: number;
	/** How often (seconds) the engine polls Shadow for context. */
	pollIntervalSeconds: number;
}

/**
 * The full settings surface the expanded island reads/writes: service endpoints
 * (Core/Shadow URLs + optional token) plus engine tunables. Mirrors the persisted
 * `IslandServiceConfig` on the main side without exposing file paths.
 */
export interface IslandSettings {
	coreBaseUrl: string;
	coreToken: string | null;
	engine: EngineSettings;
	shadowBaseUrl: string;
}

/** Patch for `settings:set`: any subset of the settings surface. */
export interface IslandSettingsPatch {
	coreBaseUrl?: string;
	coreToken?: string | null;
	engine?: Partial<EngineSettings>;
	shadowBaseUrl?: string;
}

// ── IPC channel names ────────────────────────────────────────────────────────

export const IPC = {
	appearance: {
		get: "appearance:get",
	},
	consent: {
		get: "consent:get",
		set: "consent:set",
		changed: "consent:changed",
	},
	settings: {
		get: "settings:get",
		set: "settings:set",
	},
	theme: {
		get: "theme:get",
		changed: "theme:changed",
	},
	window: {
		toggle: "window:toggle",
		visibilityChanged: "window:visibilityChanged",
		cursorMove: "window:cursorMove",
	},
	core: {
		health: "core:health",
		chatStreamStart: "core:chatStreamStart",
		chatStreamAbort: "core:chatStreamAbort",
		completions: "core:completions",
		callTool: "core:callTool",
		sidecarStatus: "core:sidecarStatus",
		sidecarStart: "core:sidecarStart",
		streamPart: "core:streamPart",
		streamEnd: "core:streamEnd",
		transcribe: "core:transcribe",
		agents: "core:agents",
		acpConfig: "core:acpConfig",
		engineModels: "core:engineModels",
		conversations: "core:conversations",
	},
	// Plugin (Ryu App / Companion) host bridge. All Core HTTP runs in the main
	// process (CORS); the renderer's sandboxed-iframe host reaches Core only via
	// these channels. `hostStreamChunk`/`hostStreamEnd` are main → renderer events.
	plugins: {
		contributions: "plugins:contributions",
		uiBundle: "plugins:uiBundle",
		hostInvoke: "plugins:hostInvoke",
		coreHttp: "plugins:coreHttp",
		hostStreamStart: "plugins:hostStreamStart",
		hostStreamAbort: "plugins:hostStreamAbort",
		hostStreamChunk: "plugins:hostStreamChunk",
		hostStreamEnd: "plugins:hostStreamEnd",
	},
	// Command-surface summon events (main -> renderer). `open` is the global-hotkey
	// summon (show + focus + open the command palette); `blur` fires when the
	// window loses focus so the renderer can dismiss the command surface.
	command: {
		open: "command:open",
		blur: "command:blur",
	},
	catalog: {
		sources: "catalog:sources",
		list: "catalog:list",
		install: "catalog:install",
		selectSource: "catalog:selectSource",
	},
	voice: {
		get: "voice:get",
		changed: "voice:changed",
		toggle: "voice:toggle",
		start: "voice:start",
		stop: "voice:stop",
		recordingState: "voice:recordingState",
		cycleAgent: "voice:cycleAgent",
		target: "voice:target",
	},
	// System-wide dictation: a separate global shortcut from voice input. The main
	// process registers it and forwards `toggle`/`start`/`stop` to the renderer,
	// which captures audio and hands the WAV back on `submit`. The main process
	// transcribes, optionally post-processes, and types/pastes the text into
	// whatever native app currently has OS focus.
	dictation: {
		get: "dictation:get",
		changed: "dictation:changed",
		toggle: "dictation:toggle",
		start: "dictation:start",
		stop: "dictation:stop",
		recordingState: "dictation:recordingState",
		submit: "dictation:submit",
	},
	agents: {
		get: "agents:get",
		set: "agents:set",
		changed: "agents:changed",
	},
	tts: {
		get: "tts:get",
		changed: "tts:changed",
		speak: "tts:speak",
	},
	shadow: {
		getCurrentContext: "shadow:getCurrentContext",
		getProactive: "shadow:getProactive",
		getProactiveInbox: "shadow:getProactiveInbox",
		postFeedback: "shadow:postFeedback",
		getCaptureControl: "shadow:getCaptureControl",
		setCaptureControl: "shadow:setCaptureControl",
	},
	suggestions: {
		start: "suggestions:start",
		stop: "suggestions:stop",
		status: "suggestions:status",
		feedback: "suggestions:feedback",
		new: "suggestions:new",
		cleared: "suggestions:cleared",
	},
	meetings: {
		start: "meetings:start",
		finalize: "meetings:finalize",
		event: "meetings:event",
	},
	quests: {
		accept: "quests:accept",
		dismiss: "quests:dismiss",
		event: "quests:event",
	},
	// Open a URL in the user's default browser (the smart-bar's navigate/search
	// intents). Renderer -> main, invoke/return so the renderer can await the open.
	system: {
		openExternal: "system:openExternal",
		attachFiles: "system:attachFiles",
	},
	update: {
		getVersion: "update:getVersion",
		getAutoUpdate: "update:getAutoUpdate",
		setAutoUpdate: "update:setAutoUpdate",
		getState: "update:getState",
		quitAndInstall: "update:quitAndInstall",
		available: "update:available",
		downloaded: "update:downloaded",
	},
} as const;

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
	/** Transcribe captured WAV audio with the given engine. Never rejects. */
	transcribe(audio: ArrayBuffer, engine: string): Promise<CoreTranscribeResult>;
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
 * The renderer only captures audio; `submit` hands the WAV to the main process,
 * which transcribes, optionally post-processes, and inserts.
 */
export interface IslandDictationApi {
	/** Read the current dictation blob (raw JSON), or `null` if unset. */
	get(): Promise<string | null>;
	/** Subscribe to live dictation setting changes (raw JSON). Returns unsubscribe. */
	onChanged(listener: (value: string) => void): () => void;
	/** Subscribe to a push-to-talk *start* signal (hold-to-talk key-down). */
	onStart(listener: () => void): () => void;
	/** Subscribe to a push-to-talk *stop* signal (hold-to-talk key release). */
	onStop(listener: () => void): () => void;
	/** Subscribe to dictation shortcut presses (toggle mode). Returns unsubscribe. */
	onToggle(listener: () => void): () => void;
	/**
	 * Report whether capture is active so the main process arms its global key hook
	 * (hold-to-talk release) only while recording. Fire-and-forget.
	 */
	setRecording(active: boolean): void;
	/**
	 * Hand captured 16 kHz mono WAV to the main process for transcription,
	 * optional post-processing, and insertion into the focused app. Never rejects.
	 */
	submit(audio: ArrayBuffer): Promise<DictationSubmitResult>;
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
 * Appearance methods exposed to the renderer. The value is the raw JSON string
 * of the shared island-appearance blob persisted in Core. The renderer reads it
 * on mount to pick its shape styling and (in the acrylic window) to report its
 * footprint; a change in the *window mode* recreates + reloads the window, so a
 * one-shot read on mount always reflects the current mode.
 */
export interface IslandAppearanceApi {
	/** Read the current appearance blob (raw JSON), or `null` if unset. */
	get(): Promise<string | null>;
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
	 * them to Core as image file-parts. Never rejects.
	 */
	attachFiles(): Promise<IslandAttachment[]>;
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
	meetings: IslandMeetingsApi;
	plugins: IslandPluginsApi;
	quests: IslandQuestsApi;
	settings: IslandSettingsApi;
	shadow: IslandShadowApi;
	suggestions: IslandSuggestionsApi;
	system: IslandSystemApi;
	theme: IslandThemeApi;
	tts: IslandTtsApi;
	update: IslandUpdateApi;
	version: string;
	voice: IslandVoiceApi;
	win: IslandWinApi;
	window: IslandWindowApi;
}
