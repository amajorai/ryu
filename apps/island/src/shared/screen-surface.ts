// Contract for the on-screen generative UI window.
//
// The Island chat decides WHICH generated screen is live (see
// `deriveLiveAgentUiSurface` in @ryu/blocks); main owns a separate frameless,
// always-on-top, mostly click-through window that draws it on the desktop, so a
// generated screen is not boxed into the Island's ~380px panel. Flow:
//
//   Island renderer --show(state)--> main --state--> screen window renderer
//   screen window --submit(value) / dismiss--> main --> Island renderer
//
// The screen window runs its own minimal, sandboxed preload
// (`window.islandSurface`), not the Island's full API: it can only render, report
// interaction, and read the theme and language packs. That preload imports this
// module for types only and keeps its own copy of the channel names
// (`preload/surface-channels.ts`, pinned to these by a test): a runtime import
// shared by both preload entries would become a chunk a sandboxed preload cannot
// `require`. Keep this module dependency-free for main and the Island preload.

import type { LanguagePacksResult } from "./ipc.ts";

export const SURFACE_CHANNELS = {
	/** Island → main: the screen to show (`surface: null` hides it). */
	show: "surface:show",
	/** main → screen window: the state to render. */
	state: "surface:state",
	/** screen window → main: the window finished loading and can take state. */
	ready: "surface:ready",
	/** screen window → main: capture the mouse over the card, else click through. */
	setMouseCapture: "surface:setMouseCapture",
	/** screen window → main → Island: a value from the screen's `submit` action. */
	submit: "surface:submit",
	/** screen window → main → Island: the user closed the screen. */
	dismiss: "surface:dismiss",
} as const;

/** One generated screen, as `deriveLiveAgentUiSurface` reports it. */
export interface ScreenSurface {
	format?: "json-render" | "a2ui";
	id: string;
	spec: unknown;
	title?: string;
}

export interface ScreenSurfaceState {
	surface: ScreenSurface | null;
	updating: boolean;
}

export const HIDDEN_SCREEN_SURFACE: ScreenSurfaceState = {
	surface: null,
	updating: false,
};

/** What main sends the screen window: the state plus the edge facing the Island. */
export interface ScreenSurfaceRenderState extends ScreenSurfaceState {
	anchor: "top" | "bottom";
}

/** Island-side API (`window.island.surface`). */
export interface IslandSurfaceHostApi {
	onDismiss(listener: () => void): () => void;
	onSubmit(listener: (value: unknown) => void): () => void;
	show(state: ScreenSurfaceState): void;
}

/** Screen-window API (`window.islandSurface`). */
export interface IslandSurfaceWindowApi {
	dismiss(): void;
	/** Read-only catalog read so the screen follows the Island's language pack. */
	languagePacks: {
		get(): Promise<LanguagePacksResult>;
	};
	onState(listener: (state: ScreenSurfaceRenderState) => void): () => void;
	ready(): void;
	setMouseCapture(capture: boolean): void;
	submit(value: unknown): void;
	theme: {
		get(): Promise<string | null>;
		onChanged(listener: (value: string) => void): () => void;
	};
}

export interface SurfaceRect {
	height: number;
	width: number;
	x: number;
	y: number;
}

/** Widest the screen card may grow; the window is this plus breathing room. */
export const SURFACE_MAX_WIDTH = 560;
const SURFACE_MAX_HEIGHT = 760;
const SURFACE_MARGIN = 24;

/**
 * Where the screen window goes: horizontally centred on the Island's display,
 * on the opposite vertical half from the Island so it never covers it. The card
 * hugs the window edge nearest the Island (see `surfaceAnchor`).
 */
export function screenSurfaceBounds(
	workArea: SurfaceRect,
	island: SurfaceRect
): SurfaceRect {
	const width = Math.min(
		SURFACE_MAX_WIDTH + SURFACE_MARGIN * 2,
		Math.max(0, workArea.width - SURFACE_MARGIN * 2)
	);
	const islandBelowMiddle =
		island.y + island.height / 2 > workArea.y + workArea.height / 2;
	const free = islandBelowMiddle
		? island.y - workArea.y
		: workArea.y + workArea.height - (island.y + island.height);
	// Use the space beside the Island when there is enough; otherwise overlap the
	// rest of the display rather than shrinking to an unusable sliver.
	const usable =
		free >= 320 ? free - SURFACE_MARGIN : workArea.height - SURFACE_MARGIN * 2;
	const height = Math.max(0, Math.min(SURFACE_MAX_HEIGHT, usable));
	const x = Math.round(workArea.x + (workArea.width - width) / 2);
	let y: number;
	if (free >= 320) {
		y = islandBelowMiddle
			? island.y - SURFACE_MARGIN / 2 - height
			: island.y + island.height + SURFACE_MARGIN / 2;
	} else {
		y = workArea.y + (workArea.height - height) / 2;
	}
	return {
		height: Math.round(height),
		width: Math.round(width),
		x,
		y: Math.round(y),
	};
}

/** Which window edge the card hugs: the one facing the Island. */
export function surfaceAnchor(
	workArea: SurfaceRect,
	island: SurfaceRect
): "top" | "bottom" {
	return island.y + island.height / 2 > workArea.y + workArea.height / 2
		? "bottom"
		: "top";
}
