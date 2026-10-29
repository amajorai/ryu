// Channel names for the on-screen generative UI window's preload (`surface.ts`).
//
// The screen window renders agent-authored UI, so it runs a sandboxed renderer.
// A sandboxed preload's `require` resolves only Electron's sandbox modules — never
// a relative chunk — so each preload entry must bundle into one self-contained
// `.cjs`. Rollup hoists any local module that BOTH preload entries import at
// runtime into a shared `chunks/*.cjs`, which would break both windows. So this
// module stays dependency-free and is imported only by `surface.ts`; the values
// are pinned to the shared contract (`SURFACE_CHANNELS`, `IPC.theme`,
// `IPC.languagePacks`) and the import graphs are checked by `sandbox.test.ts`.

export const SCREEN_WINDOW_CHANNELS = {
	/** screen window → main → Island: the user closed the screen. */
	dismiss: "surface:dismiss",
	/** screen window → main: read the language-pack catalog (`IPC.languagePacks.get`). */
	languagePacksGet: "language-packs:get",
	/** screen window → main: the window finished loading and can take state. */
	ready: "surface:ready",
	/** screen window → main: capture the mouse over the card, else click through. */
	setMouseCapture: "surface:setMouseCapture",
	/** main → screen window: the state to render. */
	state: "surface:state",
	/** screen window → main → Island: a value from the screen's `submit` action. */
	submit: "surface:submit",
	/** main → screen window: the theme changed (`IPC.theme.changed`). */
	themeChanged: "theme:changed",
	/** screen window → main: read the theme (`IPC.theme.get`). */
	themeGet: "theme:get",
} as const;
