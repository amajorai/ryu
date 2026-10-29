// The pointer position as the X server reports it, for Linux X11 sessions.
//
// On X11, Electron's `screen.getCursorScreenPoint()` answers from the location
// Chromium cached from the last X input event its windows received, and asks the
// X server only while that cache is empty. A window that ignores mouse events
// receives no such events, and the resting translucent Island is exactly such a
// window: the polled point stops at its first reading, so the Island never sees
// the pointer arrive and never takes it. `XQueryPointer` asks the X server on
// every call and keeps answering while every window is click-through.
//
// libX11 is one of Electron's own shared-library dependencies on Linux, so it is
// present wherever the Island runs; it is reached through the optional `koffi`
// module that already carries the macOS and Windows native bridges.
//
// The X server's pointer is the right one only when Electron itself renders on
// X11. A Wayland session also keeps an XWayland display, so `XOpenDisplay`
// succeeds there while Electron draws natively on Wayland and the X pointer is
// stale. The X path therefore runs outside a Wayland session, and inside one
// whenever Electron's effective Ozone platform is X11: an explicit `x11`
// request, or no request at all on an Electron older than 38, which still
// defaults to XWayland (native Wayland became the default in Electron 38).
//
// Another OS, a Wayland-rendered Electron, a missing `koffi`, no X display, or a
// failing X call yields `null`, and the caller keeps Electron's reading.

import { createRequire } from "node:module";
import type { Display } from "electron";

const require = createRequire(import.meta.url);

/** A pointer position in X root-window coordinates (physical pixels). */
export interface X11PointerPoint {
	x: number;
	y: number;
}

type QueryPointer = () => X11PointerPoint | null;

/**
 * `undefined` until first use; `null` once the X path proved unusable (Electron
 * not on X11, no X display, or a native call failed).
 */
let queryPointer: QueryPointer | null | undefined;

/** The value of `--<name>=<value>` on the Electron command line, if present. */
function switchValue(
	argv: readonly string[],
	name: string
): string | undefined {
	const prefix = `--${name}=`;
	return argv
		.find((argument) => argument.startsWith(prefix))
		?.slice(prefix.length);
}

/**
 * The first Electron major whose Ozone platform hint defaults to `auto`; it also
 * dropped the `ELECTRON_OZONE_PLATFORM_HINT` environment variable.
 */
const NATIVE_WAYLAND_DEFAULT_MAJOR = 38;

/** Whether this Electron defaults to native Wayland. Without a version (not
 *  under Electron) the pinned Electron 33 behaviour holds. */
function defaultsToNativeWayland(): boolean {
	const major = Number.parseInt(process.versions.electron ?? "", 10);
	return Number.isFinite(major) && major >= NATIVE_WAYLAND_DEFAULT_MAJOR;
}

/**
 * Whether Electron renders through X11 in this process. Outside a Wayland
 * session it always does. Inside one, Chromium's ozone platform decides: an
 * explicit `--ozone-platform` wins over `--ozone-platform-hint`, which (before
 * Electron 38) wins over the `ELECTRON_OZONE_PLATFORM_HINT` environment hint.
 * `x11` keeps Electron on X11 and `wayland` or `auto` put it on Wayland. With no
 * request, Electron before 38 runs on X11 through XWayland and 38+ on Wayland.
 */
function electronRunsOnX11(): boolean {
	if (!process.env.WAYLAND_DISPLAY) {
		return true;
	}
	const nativeWaylandDefault = defaultsToNativeWayland();
	const requested =
		switchValue(process.argv, "ozone-platform") ??
		switchValue(process.argv, "ozone-platform-hint") ??
		(nativeWaylandDefault
			? undefined
			: process.env.ELECTRON_OZONE_PLATFORM_HINT || undefined);
	if (requested === undefined) {
		return !nativeWaylandDefault;
	}
	return requested === "x11";
}

function openQueryPointer(): QueryPointer | null {
	try {
		// SAFETY: koffi's own declarations type the loader; each X11 symbol below
		// is bound with its C prototype from <X11/Xlib.h>.
		const koffi = require("koffi") as typeof import("koffi");
		const xlib = koffi.load("libX11.so.6");
		const openDisplay = xlib.func("void *XOpenDisplay(const char *)");
		const defaultRootWindow = xlib.func(
			"unsigned long XDefaultRootWindow(void *)"
		);
		const query = xlib.func(
			"int XQueryPointer(void *, unsigned long, _Out_ unsigned long *, _Out_ unsigned long *, _Out_ int *, _Out_ int *, _Out_ int *, _Out_ int *, _Out_ unsigned int *)"
		);
		// One connection for the process lifetime, used only from the main
		// thread; the OS closes it on exit.
		const display: unknown = openDisplay(null);
		if (!display) {
			return null;
		}
		const root: unknown = defaultRootWindow(display);
		return () => {
			const rootX = [0];
			const rootY = [0];
			// False when the pointer is on another X screen; its root coordinates
			// then belong to that screen, so report nothing for this sample.
			const sameScreen = query(
				display,
				root,
				[0],
				[0],
				rootX,
				rootY,
				[0],
				[0],
				[0]
			);
			return sameScreen ? { x: rootX[0], y: rootY[0] } : null;
		};
	} catch {
		return null;
	}
}

/**
 * The pointer's X root-window position, or `null` off Linux, when Electron is
 * not on X11, or without a working X display. The display connection opens on
 * first use and is reused; a call that throws is not retried, so the poll timer
 * never sees an exception from the native library.
 */
export function queryX11Pointer(): X11PointerPoint | null {
	if (process.platform !== "linux") {
		return null;
	}
	if (queryPointer === undefined) {
		queryPointer = electronRunsOnX11() ? openQueryPointer() : null;
	}
	if (!queryPointer) {
		return null;
	}
	try {
		return queryPointer();
	} catch {
		queryPointer = null;
		return null;
	}
}

/**
 * Map an X root-window point (physical pixels) to Electron's screen DIP the way
 * Chromium's X11 screen does: take the display nearest the point in pixel
 * space, scale the offset from its pixel origin by that display's factor, add
 * its DIP origin, and floor.
 */
export function x11PointToDip(
	point: X11PointerPoint,
	displays: readonly Display[]
): X11PointerPoint {
	let nearest: Display | undefined;
	let nearestDistance = Number.POSITIVE_INFINITY;
	for (const display of displays) {
		const left = display.nativeOrigin.x;
		const top = display.nativeOrigin.y;
		const right =
			left + Math.ceil(display.bounds.width * display.scaleFactor) - 1;
		const bottom =
			top + Math.ceil(display.bounds.height * display.scaleFactor) - 1;
		const dx = Math.max(left - point.x, 0, point.x - right);
		const dy = Math.max(top - point.y, 0, point.y - bottom);
		const distance = dx * dx + dy * dy;
		if (distance < nearestDistance) {
			nearest = display;
			nearestDistance = distance;
		}
	}
	if (!nearest) {
		return point;
	}
	return {
		x: Math.floor(
			nearest.bounds.x +
				(point.x - nearest.nativeOrigin.x) / nearest.scaleFactor
		),
		y: Math.floor(
			nearest.bounds.y +
				(point.y - nearest.nativeOrigin.y) / nearest.scaleFactor
		),
	};
}
