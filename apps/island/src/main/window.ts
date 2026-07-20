import { createRequire } from "node:module";
import { join } from "node:path";
import {
	BrowserWindow,
	type BrowserWindowConstructorOptions,
	screen,
} from "electron";
import {
	type IslandBackground,
	isMaterialAppearance,
} from "../shared/appearance.ts";
import { getEdgeOffset } from "./edge-offset.ts";
import { restorePosition, restingPill } from "./position.ts";
import { DEFAULT_DOCK_ZONE, zoneWindowPosition } from "./zones.ts";

// `mica-electron` is a Windows-only NATIVE module (Win11 Mica/Acrylic via DWM).
// It is an optionalDependency and loaded lazily so the app builds + runs on macOS/
// Linux (and on Windows without it installed): if the require fails we fall back to
// Electron's built-in `backgroundMaterial`/`vibrancy`. macOS has no Mica — its
// native equivalent is `vibrancy`, which the acrylic options already set.
const require = createRequire(import.meta.url);

/** The extra effect methods a `MicaBrowserWindow` carries beyond BrowserWindow. */
type MicaWindow = BrowserWindow & {
	setAcrylic(): void;
	setDarkTheme(): void;
	setMicaAcrylicEffect(): void;
	setRoundedCorner(): void;
};

interface MicaElectron {
	IS_WINDOWS_11: boolean;
	MicaBrowserWindow: new (opts: BrowserWindowConstructorOptions) => MicaWindow;
}

/** Load `mica-electron` on Windows, or `null` if unavailable (other OS / not installed). */
function loadMica(): MicaElectron | null {
	if (process.platform !== "win32") {
		return null;
	}
	try {
		return require("mica-electron") as MicaElectron;
	} catch {
		return null;
	}
}

// In the translucent appearance the window stays at the maximum panel size at
// all times; the morphing island shapes are drawn inside it by the renderer and
// everything outside them is click-through, so the oversized window never blocks
// the apps underneath. It must hold the widest/tallest footprint — the expanded
// chat: logo circle (40) + gap (8) + panel (400) = 448 wide, 480 tall — PLUS a
// generous margin on every side so the shapes' drop shadows (`shadow-2xl`) and
// ring are never clipped by the window edge. The extra area is transparent +
// click-through, so a roomy window costs nothing but stops the cut-off shadows.
const PANEL_WIDTH = 600;
const PANEL_HEIGHT = 620;
// The acrylic window is the island itself (a native OS material fills the whole
// window rectangle), so it starts at the resting footprint and the renderer
// resizes it per state via `win:setContentSize`. Exported so the auto-jump gate
// can tell whether a material window is at rest (vs morphed open) before moving it.
export const ACRYLIC_START_WIDTH = 144;
export const ACRYLIC_START_HEIGHT = 44;

/** Window options for the translucent appearance: oversized + transparent. */
function translucentOptions(): BrowserWindowConstructorOptions {
	return {
		width: PANEL_WIDTH,
		height: PANEL_HEIGHT,
		frame: false,
		transparent: true,
		resizable: false,
		skipTaskbar: true,
		hasShadow: false,
		show: false,
	};
}

/**
 * Window options for the acrylic appearance: a window-tracked, non-transparent
 * window carrying a native OS material. `backgroundMaterial: "acrylic"` drives
 * the Windows 11 blur; `vibrancy: "under-window"` drives macOS vibrancy (each is
 * ignored on the other platform). `backgroundColor` is fully transparent so the
 * material shows through the web layer.
 */
function acrylicOptions(): BrowserWindowConstructorOptions {
	return {
		width: ACRYLIC_START_WIDTH,
		height: ACRYLIC_START_HEIGHT,
		frame: false,
		transparent: false,
		backgroundColor: "#00000000",
		backgroundMaterial: "acrylic",
		vibrancy: "under-window",
		resizable: false,
		skipTaskbar: true,
		hasShadow: true,
		show: false,
	};
}

/**
 * Window options for the `mica` appearance when `mica-electron` is driving it:
 * like {@link acrylicOptions} but WITHOUT `backgroundMaterial`/`vibrancy` — the
 * effect is applied natively by mica-electron after the window is created.
 */
function micaOptions(): BrowserWindowConstructorOptions {
	return {
		width: ACRYLIC_START_WIDTH,
		height: ACRYLIC_START_HEIGHT,
		frame: false,
		transparent: false,
		backgroundColor: "#00000000",
		resizable: false,
		skipTaskbar: true,
		hasShadow: true,
		show: false,
	};
}

/** Apply the dark Win11 Mica/Acrylic material to a freshly-created mica window. */
function applyMicaEffect(win: MicaWindow, mica: MicaElectron): void {
	// Dark theme to match the Siri look; rounded corners (DWM).
	win.setDarkTheme();
	win.setRoundedCorner();
	// Acrylic actually blurs what is behind (Mica only samples the wallpaper), so
	// it is the closer match to the frosted-glass goal. Win10 uses plain Acrylic.
	if (mica.IS_WINDOWS_11) {
		win.setMicaAcrylicEffect();
	} else {
		win.setAcrylic();
	}
}

/**
 * Creates the frameless, always-on-top island window for the given appearance.
 *
 * - `translucent` (default): an oversized transparent window anchored to the
 *   bottom-right of the primary display's work area. It starts click-through; the
 *   renderer captures the mouse only while the pointer is over an island shape.
 * - `acrylic`: a window-tracked native-material window (built-in
 *   `backgroundMaterial`/`vibrancy`). It is the island, so it starts interactive
 *   and resizes to the visible footprint as the island morphs.
 * - `mica`: same window-tracked behaviour as `acrylic`, but on Windows the Win11
 *   Mica/Acrylic material is applied via the `mica-electron` native module. If
 *   that module is unavailable (non-Windows, or not installed), it falls back to
 *   the built-in acrylic options (so macOS still gets `vibrancy`).
 */
export function createIslandWindow(
	background: IslandBackground = "translucent"
): BrowserWindow {
	const material = isMaterialAppearance(background);
	const startWidth = material ? ACRYLIC_START_WIDTH : PANEL_WIDTH;
	const startHeight = material ? ACRYLIC_START_HEIGHT : 0;
	const primary = screen.getPrimaryDisplay();
	const pill = restingPill(startWidth, startHeight, material);
	const { x, y } = zoneWindowPosition(
		primary.workArea,
		DEFAULT_DOCK_ZONE,
		pill,
		getEdgeOffset()
	);

	// Use mica-electron only for the `mica` appearance on Windows; otherwise the
	// material path uses Electron's built-in acrylic/vibrancy options.
	const mica = background === "mica" ? loadMica() : null;
	let baseOptions: BrowserWindowConstructorOptions;
	if (mica) {
		baseOptions = micaOptions();
	} else if (material) {
		baseOptions = acrylicOptions();
	} else {
		baseOptions = translucentOptions();
	}

	const options: BrowserWindowConstructorOptions = {
		...baseOptions,
		x,
		y,
		webPreferences: {
			preload: join(import.meta.dirname, "../preload/index.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
		},
	};

	let win: BrowserWindow;
	if (mica) {
		const micaWin = new mica.MicaBrowserWindow(options);
		applyMicaEffect(micaWin, mica);
		win = micaWin;
	} else {
		win = new BrowserWindow(options);
	}

	// Voice input captures the mic via getUserMedia in the renderer; without an
	// explicit grant Electron denies it silently. Allow only media (audio) for
	// this window's session — everything else stays denied.
	const isMediaPermission = (permission: string): boolean =>
		permission === "media" || permission === "audioCapture";
	win.webContents.session.setPermissionRequestHandler(
		(_wc, permission, callback) => callback(isMediaPermission(permission))
	);
	win.webContents.session.setPermissionCheckHandler((_wc, permission) =>
		isMediaPermission(permission)
	);

	win.setAlwaysOnTop(true, "screen-saver");
	// macOS: keep the island on every Space and visible over fullscreen apps, so a
	// companion overlay never vanishes when the user switches Space or enters a
	// fullscreen window. This is the macOS analog of auto-jump's "follow the active
	// desktop" on Windows. No-op on Windows/Linux (the option is ignored there).
	if (process.platform === "darwin") {
		win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
	}
	// Translucent: start click-through; the renderer re-captures on pointerenter.
	// Material (acrylic/mica): the whole window is the island, so it stays interactive.
	if (!material) {
		win.setIgnoreMouseEvents(true, { forward: true });
	}

	win.once("ready-to-show", () => {
		restorePosition(win, material);
		win.show();
	});

	if (process.env.ELECTRON_RENDERER_URL) {
		win.loadURL(process.env.ELECTRON_RENDERER_URL);
	} else {
		win.loadFile(join(import.meta.dirname, "../renderer/index.html"));
	}

	return win;
}
