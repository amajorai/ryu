// Type-only: the Island's sandboxed preload imports this module at runtime (for
// `IPC`), and a sandboxed preload cannot `require` a package such as `zod`.
import type { z } from "zod";

/** JSON values carried across the Island IPC boundary. */
export type IslandIpcValue = z.infer<ReturnType<typeof z.json>>;

import type { IslandPlacement } from "./placement.ts";
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

// ── Window control (U1) ──────────────────────────────────────────────────────

/** IPC channel names for window control. Fire-and-forget, renderer -> main unless noted. */
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
	 * Main already knows the island footprint (from `setContentSize`), so the
	 * gesture carries no geometry.
	 */
	dragStart: "win:dragStart",
	/** Move the window by a pointer delta (manual drag of the pill region). */
	moveBy: "win:moveBy",
	/** Snap to the nearest zone, persist, and hide the overlay when a drag ends. */
	dragEnd: "win:dragEnd",
	/**
	 * Report the visible island footprint. Main pins it to the island's anchor
	 * (see `shared/placement.ts`) and shifts it to stay on-screen. In
	 * native-material modes the window is resized to it and the accompanying
	 * shapes clip the OS backdrop to each painted Island surface; the
	 * `translucent` window keeps its fixed oversized size and only moves.
	 */
	setContentSize: "win:setContentSize",
	/** Follow in-flight shape animations without resizing the native window. */
	setMaterialShapes: "win:setMaterialShapes",
	/**
	 * Main -> renderer: the island's placement changed (it was docked somewhere
	 * else), so the renderer must align its group to the new anchor corner.
	 */
	placement: "win:placement",
	/**
	 * Renderer -> main: the renderer has laid out a placement, so main can move
	 * the fixed-size translucent window to match without a misaligned frame.
	 */
	placementApplied: "win:placementApplied",
} as const;

/** Payload for `win:setMouseCapture`. */
export interface SetMouseCapturePayload {
	/** `true` -> capture clicks on the window; `false` -> click-through. */
	capture: boolean;
}

/** Payload for `win:moveBy`: a relative pixel delta from the drag pointer move. */
export interface MoveByPayload {
	dx: number;
	dy: number;
}

/** A visible rounded Island surface, relative to the material window. */
export interface IslandMaterialContour {
	height: number;
	radius: number;
	width: number;
	x: number;
	y: number;
}

/** Payload for `win:setContentSize`: the visible island footprint in CSS px. */
export interface ContentSizePayload {
	/** Whether this footprint is the expanded panel. */
	expanded: boolean;
	height: number;
	shapes: IslandMaterialContour[];
	width: number;
}

// The window-control API exposed to the renderer (`window.island.win`).
export interface IslandWinApi {
	/** Signal drag completion so main snaps to a zone + persists the position. */
	dragEnd(): void;
	/** Signal drag start so main shows the snap overlay. */
	dragStart(): void;
	/**
	 * Whether a click-through window still receives mouse moves (Electron's
	 * `forward` option): true on macOS and Windows, false on Linux. Where it is
	 * false the renderer never sees `pointerenter` while click-through, so it
	 * hit-tests the polled cursor ({@link IslandWindowApi.onCursorMove}) instead.
	 */
	readonly forwardsMouseMoves: boolean;
	/** Placement the window was created with (before any `onPlacement` event). */
	initialPlacement: IslandPlacement;
	/** Move the window by a relative delta during a manual drag. */
	moveBy(dx: number, dy: number): void;
	/** Subscribe to placement changes; returns an unsubscribe function. */
	onPlacement(listener: (placement: IslandPlacement) => void): () => void;
	/** Acknowledge that `placement` is now laid out (see `placementApplied`). */
	placementApplied(placement: IslandPlacement): void;
	/**
	 * Report the visible island footprint (and whether it is the expanded panel).
	 * Main pins it to the island's anchor and shifts it to stay on the display;
	 * the material window is resized to the footprint.
	 */
	setContentSize(
		width: number,
		height: number,
		expanded: boolean,
		contours: IslandMaterialContour[]
	): void;
	/** Clip the native backdrop to the shapes currently painted by the renderer. */
	setMaterialShapes: (contours: IslandMaterialContour[]) => void;
	/** Enable/disable mouse capture on the window (click-through toggle). */
	setMouseCapture(capture: boolean): void;
}

// ── IPC channel names ────────────────────────────────────────────────────────

export const IPC = {
	appearance: {
		get: "appearance:get",
		notch: "appearance:notch",
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
	languagePacks: {
		get: "language-packs:get",
	},
	// Plugin (Ryu App / Companion) host bridge. All Core HTTP runs in the main
	// process (CORS); the renderer's sandboxed-iframe host reaches Core only via
	// these channels. `hostStreamChunk`/`hostStreamEnd` are main → renderer events.
	plugins: {
		sourceChanged: "plugins:sourceChanged",
		contributions: "plugins:contributions",
		uiBundle: "plugins:uiBundle",
		uiBundleAbort: "plugins:uiBundleAbort",
		hostInvoke: "plugins:hostInvoke",
		coreHttp: "plugins:coreHttp",
		hostStreamStart: "plugins:hostStreamStart",
		hostStreamAbort: "plugins:hostStreamAbort",
		hostStreamChunk: "plugins:hostStreamChunk",
		hostStreamEnd: "plugins:hostStreamEnd",
		shortcut: "plugins:shortcut",
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
	keybindings: {
		get: "keybindings:get",
		changed: "keybindings:changed",
	},
	tts: {
		get: "tts:get",
		changed: "tts:changed",
		speak: "tts:speak",
	},
	shadow: {
		getSpeechHistory: "shadow:getSpeechHistory",
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

// ── Payload and bridge types ─────────────────────────────────────────────────
//
// The rest of the contract lives in type-only siblings and is re-exported here,
// so every caller keeps importing from this one module.

export type * from "./ipc-api.ts";
export type * from "./ipc-core.ts";
export type * from "./ipc-plugins.ts";
export type * from "./ipc-services.ts";
