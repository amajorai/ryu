import { createRequire } from "node:module";
import { release } from "node:os";
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
import { notchWindowRect } from "../shared/notch.ts";
import { placementArg, TRANSLUCENT_WINDOW_INSET } from "../shared/placement.ts";
import {
	placeAtAnchor,
	rectAt,
	rectCenter,
	type Size,
	TRANSLUCENT_WINDOW_SIZE,
	windowOriginFor,
} from "./anchor.ts";
import { getEdgeOffset } from "./edge-offset.ts";
import {
	applyMaterialMask,
	hasMaterialMask,
	supportsMacLiquidGlass,
} from "./material-mask.ts";
import {
	allowsMicrophoneCheck,
	allowsMicrophoneRequest,
} from "./media-permissions.ts";
import { getNotchGeometry } from "./notch.ts";
import { initialAnchor } from "./position.ts";
import { attachPositioner } from "./positioner.ts";
import { presentWindow } from "./visibility.ts";
import { supportsBuiltInAcrylic } from "./windows-material.ts";

// `mica-electron` is a Windows-only NATIVE module (Win11 Mica/Acrylic via DWM).
// It is an optionalDependency and loaded lazily so the app builds + runs on macOS/
// Linux (and on Windows without it installed): if the require fails we fall back to
// Electron's built-in `backgroundMaterial`/`vibrancy`. macOS has no Mica — its
// native equivalent is `vibrancy`, which the acrylic options already set.
const require = createRequire(import.meta.url);

type MicaWindow = import("mica-electron").MicaBrowserWindow;
type MicaElectron = typeof import("mica-electron");

/** Load `mica-electron` on Windows, or `null` if unavailable (other OS / not installed). */
function loadMica(): MicaElectron | null {
	if (process.platform !== "win32") {
		return null;
	}
	try {
		// SAFETY: The optional module is loaded by its package name on Windows;
		// its installed declarations own the constructor and material methods.
		return require("mica-electron") as MicaElectron;
	} catch {
		return null;
	}
}

// In the translucent appearance the window stays at the maximum panel size at
// all times (`TRANSLUCENT_WINDOW_SIZE`); the morphing island shapes are drawn
// inside it by the renderer, aligned to the island's anchor corner, and
// everything outside them is click-through, so the oversized window never blocks
// the apps underneath.
// The acrylic window follows the island's footprint, while its material mask
// clips the native blur to the separate painted shapes. The renderer resizes it
// per state via `win:setContentSize`. Exported so the auto-jump gate
// can tell whether a material window is at rest (vs morphed open) before moving it.
export const ACRYLIC_START_WIDTH = 144;
export const ACRYLIC_START_HEIGHT = 44;

/** Window options for the translucent appearance: oversized + transparent. */
function translucentOptions(): BrowserWindowConstructorOptions {
	return {
		width: TRANSLUCENT_WINDOW_SIZE.width,
		height: TRANSLUCENT_WINDOW_SIZE.height,
		frame: false,
		transparent: true,
		resizable: false,
		skipTaskbar: true,
		hasShadow: false,
		show: false,
	};
}

/**
 * Window options for the acrylic appearance: a window-tracked transparent
 * window carrying a native OS material. `backgroundMaterial: "acrylic"` drives
 * the Windows 11 blur. macOS 26+ uses a clipped Liquid Glass view; older macOS
 * uses Sidebar vibrancy. The transparent web layer lets either native material
 * show through the lightly tinted Island surfaces.
 */
function acrylicOptions(): BrowserWindowConstructorOptions {
	const options: BrowserWindowConstructorOptions = {
		width: ACRYLIC_START_WIDTH,
		height: ACRYLIC_START_HEIGHT,
		frame: false,
		transparent: true,
		backgroundColor: "#00000000",
		resizable: false,
		skipTaskbar: true,
		hasShadow: false,
		show: false,
	};
	if (process.platform === "win32") {
		options.backgroundMaterial = "acrylic";
	}
	if (process.platform === "darwin" && !supportsMacLiquidGlass()) {
		options.vibrancy = "sidebar";
		options.visualEffectState = "active";
	}
	return options;
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
		transparent: true,
		backgroundColor: "#00000000",
		resizable: false,
		skipTaskbar: true,
		hasShadow: false,
		show: false,
	};
}

/** Apply the dark Win11 Mica/Acrylic material to a freshly-created mica window. */
function applyMicaEffect(
	win: MicaWindow,
	mica: MicaElectron,
	legacyAcrylic: boolean
): void {
	// Dark theme to match the Siri look; rounded corners (DWM).
	win.setDarkTheme();
	win.setRoundedCorner();
	// Acrylic actually blurs what is behind (Mica only samples the wallpaper), so
	// it is the closer match to the frosted-glass goal. Win10 uses plain Acrylic.
	if (mica.IS_WINDOWS_11 && !legacyAcrylic) {
		win.setMicaAcrylicEffect();
	} else {
		win.setAcrylic();
	}
}

/**
 * Creates the frameless, always-on-top island window for the given appearance.
 *
 * - `translucent`: an oversized transparent window anchored to the
 *   bottom-right of the primary display's work area. It starts click-through; the
 *   renderer captures the mouse only while the pointer is over an island shape.
 * - `acrylic` (default): a window-tracked native-material window. Mac uses
 *   Liquid Glass or Sidebar vibrancy; Windows uses built-in Acrylic or the
 *   native Windows 10 fallback. It resizes to the visible footprint.
 * - `mica`: same window-tracked behaviour as `acrylic`, but on Windows the Win11
 *   Mica/Acrylic material is applied via the `mica-electron` native module. If
 *   that module is unavailable (non-Windows, or not installed), it falls back to
 *   the built-in acrylic options (so macOS still gets `vibrancy`).
 */
export function createIslandWindow(
	background: IslandBackground = "acrylic"
): BrowserWindow {
	const notch = getNotchGeometry();
	const material = !notch && isMaterialAppearance(background);
	// Start from the persisted anchor (or the default dock) so the first frame is
	// already in place; the renderer is told the placement up front so its group
	// is aligned to the anchor corner before the window is shown.
	const anchor = initialAnchor(material);
	const startFootprint: Size = {
		width: ACRYLIC_START_WIDTH,
		height: ACRYLIC_START_HEIGHT,
	};
	const startRect = placeAtAnchor(
		anchor,
		startFootprint,
		screen.getDisplayNearestPoint(rectCenter(rectAt(anchor, startFootprint)))
			.workArea,
		getEdgeOffset()
	);
	const { x, y } = material
		? startRect
		: windowOriginFor(
				startRect,
				anchor.placement,
				TRANSLUCENT_WINDOW_SIZE,
				TRANSLUCENT_WINDOW_INSET
			);

	// Electron's built-in Acrylic needs Windows 11 22H2. The existing native
	// module covers Windows 10 and Windows 11 21H2 for the default appearance.
	const legacyAcrylic =
		background === "acrylic" &&
		process.platform === "win32" &&
		!supportsBuiltInAcrylic(release());
	const mica = background === "mica" || legacyAcrylic ? loadMica() : null;
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
			additionalArguments: [placementArg(anchor.placement)],
			contextIsolation: true,
			nodeIntegration: false,
		},
	};

	if (notch) {
		options.roundedCorners = false;
		Object.assign(
			options,
			notchWindowRect(notch, notch.width + 80, notch.height + 40)
		);
	}

	let win: BrowserWindow;
	if (mica) {
		const micaWin = new mica.MicaBrowserWindow(options);
		applyMicaEffect(micaWin, mica, legacyAcrylic);
		win = micaWin;
	} else {
		win = new BrowserWindow(options);
	}
	attachPositioner(win, material, anchor, startFootprint);

	// Voice input captures the mic via getUserMedia in the renderer; without an
	// explicit grant Electron denies it silently. Allow only media (audio) for
	// this window's session — everything else stays denied.
	win.webContents.session.setPermissionRequestHandler(
		(webContents, permission, callback, details) =>
			callback(
				allowsMicrophoneRequest(
					webContents === win.webContents,
					permission,
					details.isMainFrame,
					"mediaTypes" in details ? details.mediaTypes : undefined
				)
			)
	);
	win.webContents.session.setPermissionCheckHandler(
		(webContents, permission, _origin, details) =>
			allowsMicrophoneCheck(
				webContents === win.webContents,
				permission,
				details.isMainFrame,
				details.mediaType
			)
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
		if (material && !hasMaterialMask(win)) {
			// The renderer normally reports its first shape before this event. Mask
			// the resting logo if it has not yet done so, avoiding a shell flash.
			const [width, height] = win.getContentSize();
			const diameter = Math.min(40, height);
			applyMaterialMask(win, width, height, [
				{
					x: Math.round((width - diameter) / 2),
					y: 0,
					width: diameter,
					height: diameter,
					radius: diameter / 2,
				},
			]);
		}
		presentWindow(win, false);
	});

	if (process.env.ELECTRON_RENDERER_URL) {
		win.loadURL(process.env.ELECTRON_RENDERER_URL);
	} else {
		win.loadFile(join(import.meta.dirname, "../renderer/index.html"));
	}

	return win;
}
