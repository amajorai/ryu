import { createRequire } from "node:module";
import { type BrowserWindow, nativeImage } from "electron";
import type { IslandMaterialContour } from "../shared/ipc.ts";
import {
	type MaterialMask,
	materialMaskBitmap,
	materialMaskRects,
	normalizeMaterialMask,
} from "../shared/material-mask.ts";

const require = createRequire(import.meta.url);
// Koffi accepts bigint addresses for void* inputs. Convert all opaque pointer
// outputs through its address API so native identity never becomes a JS record.
type NativePointer = bigint | null;
type Koffi = typeof import("koffi");
type NativeArgument =
	| NativePointer
	| string
	| number
	| Buffer
	| {
			x: number;
			y: number;
			width: number;
			height: number;
	  };

function pointerCall(
	koffi: Koffi,
	callable: ReturnType<import("koffi").IKoffiLib["func"]>
) {
	return (...args: NativeArgument[]): NativePointer =>
		koffi.address(callable(...args)) || null;
}

interface LiquidGlass {
	addView(
		handle: Buffer,
		options: { cornerRadius: number; opaque: boolean; tintColor?: string }
	): number;
	isGlassSupported(): boolean;
}

interface MacBridge {
	className(target: NativePointer): string;
	getClass(name: string): NativePointer;
	koffi: Koffi;
	registerSelector(name: string): NativePointer;
	sendAddSubview(
		target: NativePointer,
		selector: NativePointer,
		view: NativePointer,
		order: number,
		relative: NativePointer
	): void;
	sendBool(
		target: NativePointer,
		selector: NativePointer,
		arg: NativePointer
	): boolean;
	sendBoolArg(
		target: NativePointer,
		selector: NativePointer,
		value: boolean
	): void;
	sendBoolNoArg(target: NativePointer, selector: NativePointer): boolean;
	sendCount(target: NativePointer, selector: NativePointer): number;
	sendDoubleArg(
		target: NativePointer,
		selector: NativePointer,
		value: number
	): void;
	sendIndex(
		target: NativePointer,
		selector: NativePointer,
		index: number
	): NativePointer;
	sendObject(target: NativePointer, selector: NativePointer): NativePointer;
	sendObjectArg(
		target: NativePointer,
		selector: NativePointer,
		arg: NativePointer
	): NativePointer;
	sendObjectBytes(
		target: NativePointer,
		selector: NativePointer,
		bytes: Buffer,
		length: number
	): NativePointer;
	sendObjectRect(
		target: NativePointer,
		selector: NativePointer,
		rect: { x: number; y: number; width: number; height: number }
	): NativePointer;
	sendVoid(target: NativePointer, selector: NativePointer): void;
	sendVoidArg(
		target: NativePointer,
		selector: NativePointer,
		arg: NativePointer
	): void;
	sendVoidRect(
		target: NativePointer,
		selector: NativePointer,
		rect: { x: number; y: number; width: number; height: number }
	): void;
}

let macBridge: MacBridge | null | undefined;
let liquidGlass: LiquidGlass | null | undefined;
const retainedMacImages = new WeakMap<BrowserWindow, NativePointer>();
const cleanupRegistered = new WeakSet<BrowserWindow>();
const glassCleanupRegistered = new WeakSet<BrowserWindow>();
const appliedWindows = new WeakSet<BrowserWindow>();
const glassFailed = new WeakSet<BrowserWindow>();
const fallbackVibrancy = new WeakSet<BrowserWindow>();
interface GlassState {
	root: NativePointer;
	surfaces: Array<{
		container: NativePointer;
		containerLayer: NativePointer;
		effectLayer: NativePointer;
	}>;
}
const glassStates = new WeakMap<BrowserWindow, GlassState>();

function getLiquidGlass(): LiquidGlass | null {
	if (liquidGlass !== undefined) {
		return liquidGlass;
	}
	if (process.platform !== "darwin") {
		liquidGlass = null;
		return null;
	}
	try {
		const candidate: LiquidGlass = require("electron-liquid-glass");
		liquidGlass = candidate.isGlassSupported() ? candidate : null;
	} catch {
		liquidGlass = null;
	}
	return liquidGlass;
}

/** True on macOS 26+ when the native addon can be loaded. */
export function supportsMacLiquidGlass(): boolean {
	return getLiquidGlass() !== null;
}

/** AppKit bridge shared by Liquid Glass and the older vibrancy fallback. */
function getMacBridge(): MacBridge | null {
	if (macBridge !== undefined) {
		return macBridge;
	}
	try {
		const koffi: Koffi = require("koffi");
		koffi.load("/System/Library/Frameworks/AppKit.framework/AppKit");
		const objc = koffi.load("/usr/lib/libobjc.A.dylib");
		koffi.struct("CGRect", {
			x: "double",
			y: "double",
			width: "double",
			height: "double",
		});
		macBridge = {
			koffi,
			className: objc.func("const char *object_getClassName(void *)"),
			getClass: pointerCall(
				koffi,
				objc.func("void *objc_getClass(const char *)")
			),
			registerSelector: pointerCall(
				koffi,
				objc.func("void *sel_registerName(const char *)")
			),
			sendAddSubview: objc.func(
				"void objc_msgSend(void *, void *, void *, long, void *)"
			),
			sendBool: objc.func("bool objc_msgSend(void *, void *, void *)"),
			sendBoolArg: objc.func("void objc_msgSend(void *, void *, bool)"),
			sendBoolNoArg: objc.func("bool objc_msgSend(void *, void *)"),
			sendCount: objc.func("unsigned long objc_msgSend(void *, void *)"),
			sendDoubleArg: objc.func("void objc_msgSend(void *, void *, double)"),
			sendIndex: pointerCall(
				koffi,
				objc.func("void *objc_msgSend(void *, void *, unsigned long)")
			),
			sendObject: pointerCall(
				koffi,
				objc.func("void *objc_msgSend(void *, void *)")
			),
			sendObjectArg: pointerCall(
				koffi,
				objc.func("void *objc_msgSend(void *, void *, void *)")
			),
			sendObjectBytes: pointerCall(
				koffi,
				objc.func("void *objc_msgSend(void *, void *, void *, unsigned long)")
			),
			sendObjectRect: pointerCall(
				koffi,
				objc.func("void *objc_msgSend(void *, void *, CGRect)")
			),
			sendVoidRect: objc.func("void objc_msgSend(void *, void *, CGRect)"),
			sendVoid: objc.func("void objc_msgSend(void *, void *)"),
			sendVoidArg: objc.func("void objc_msgSend(void *, void *, void *)"),
		};
	} catch {
		macBridge = null;
	}
	return macBridge;
}

function createMacMaskImage(
	bridge: MacBridge,
	mask: MaterialMask
): NativePointer {
	// Electron's nativeImage handle may be a tagged pointer that AppKit cannot
	// retain. Decode a PNG into a real NSImage before passing it to Cocoa.
	const raster = nativeImage.createFromBitmap(materialMaskBitmap(mask), {
		width: mask.width,
		height: mask.height,
	});
	const png = raster.toPNG();
	const selector = (name: string) => bridge.registerSelector(name);
	const data = bridge.sendObjectBytes(
		bridge.getClass("NSData"),
		selector("dataWithBytes:length:"),
		png,
		png.length
	);
	return bridge.sendObjectArg(
		bridge.sendObject(bridge.getClass("NSImage"), selector("alloc")),
		selector("initWithData:"),
		data
	);
}

function releaseMacImage(bridge: MacBridge, image: NativePointer): void {
	if (image) {
		bridge.sendVoid(image, bridge.registerSelector("release"));
	}
}

function removeGlassState(win: BrowserWindow, bridge: MacBridge): void {
	const state = glassStates.get(win);
	if (!state) {
		return;
	}
	for (const surface of state.surfaces) {
		bridge.sendVoid(
			surface.container,
			bridge.registerSelector("removeFromSuperview")
		);
	}
	glassStates.delete(win);
}

function addGlassSurface(
	bridge: MacBridge,
	glass: LiquidGlass,
	root: NativePointer,
	height: number,
	contour: IslandMaterialContour
): GlassState["surfaces"][number] {
	const selector = (name: string) => bridge.registerSelector(name);
	const flipped = bridge.sendBoolNoArg(root, selector("isFlipped"));
	const container = bridge.sendObjectRect(
		bridge.sendObject(bridge.getClass("NSView"), selector("alloc")),
		selector("initWithFrame:"),
		{
			x: contour.x,
			y: flipped ? contour.y : height - contour.y - contour.height,
			width: contour.width,
			height: contour.height,
		}
	);
	if (!container) {
		throw new Error("Native Liquid Glass container is unavailable");
	}
	let added = false;
	try {
		bridge.sendBoolArg(container, selector("setWantsLayer:"), true);
		const containerLayer = bridge.sendObject(container, selector("layer"));
		if (!containerLayer) {
			throw new Error("Native Liquid Glass container layer is unavailable");
		}
		bridge.sendBoolArg(containerLayer, selector("setMasksToBounds:"), true);
		bridge.sendDoubleArg(
			containerLayer,
			selector("setCornerRadius:"),
			contour.radius
		);
		// Each container is a separate native glass surface. There must never
		// be one full-window glass view behind the gap between Island shapes.
		bridge.sendAddSubview(
			root,
			selector("addSubview:positioned:relativeTo:"),
			container,
			-1,
			null
		);
		added = true;
		bridge.sendVoid(container, selector("release"));
		const handle = Buffer.alloc(8);
		bridge.koffi.encode(handle, "void *", container);
		const id = glass.addView(handle, {
			cornerRadius: contour.radius,
			opaque: false,
			tintColor: "#0B0B0B42",
		});
		if (id < 0) {
			throw new Error("Native Liquid Glass view could not be added");
		}
		const subviews = bridge.sendObject(container, selector("subviews"));
		const count = bridge.sendCount(subviews, selector("count"));
		for (let index = 0; index < count; index += 1) {
			const view = bridge.sendIndex(
				subviews,
				selector("objectAtIndex:"),
				index
			);
			const name = bridge.className(view);
			if (
				name.endsWith("NSGlassEffectView") ||
				name.endsWith("NSVisualEffectView")
			) {
				const effectLayer = bridge.sendObject(view, selector("layer"));
				if (effectLayer) {
					return { container, containerLayer, effectLayer };
				}
			}
		}
		throw new Error("Native Liquid Glass surface was not added");
	} catch (error) {
		bridge.sendVoid(
			container,
			selector(added ? "removeFromSuperview" : "release")
		);
		throw error;
	}
}

function updateGlassSurface(
	bridge: MacBridge,
	surface: GlassState["surfaces"][number],
	height: number,
	root: NativePointer,
	contour: IslandMaterialContour
): void {
	const selector = (name: string) => bridge.registerSelector(name);
	const flipped = bridge.sendBoolNoArg(root, selector("isFlipped"));
	bridge.sendVoidRect(surface.container, selector("setFrame:"), {
		x: contour.x,
		y: flipped ? contour.y : height - contour.y - contour.height,
		width: contour.width,
		height: contour.height,
	});
	bridge.sendDoubleArg(
		surface.containerLayer,
		selector("setCornerRadius:"),
		contour.radius
	);
	bridge.sendDoubleArg(
		surface.effectLayer,
		selector("setCornerRadius:"),
		contour.radius
	);
	bridge.sendBoolArg(surface.container, selector("setHidden:"), false);
}

/** Give each visible Island contour its own native Liquid Glass view. */
function applyMacLiquidGlassMask(
	win: BrowserWindow,
	mask: MaterialMask
): boolean {
	const bridge = getMacBridge();
	const glass = getLiquidGlass();
	if (!(bridge && glass) || glassFailed.has(win)) {
		return false;
	}
	try {
		const selector = (name: string) => bridge.registerSelector(name);
		let state = glassStates.get(win);
		if (!state) {
			const root =
				bridge.koffi.address(
					bridge.koffi.decode(win.getNativeWindowHandle(), "void *")
				) || null;
			if (!root) {
				throw new Error("Native Liquid Glass window view is unavailable");
			}
			state = { root, surfaces: [] };
			glassStates.set(win, state);
			if (!glassCleanupRegistered.has(win)) {
				glassCleanupRegistered.add(win);
				win.once("closed", () => glassStates.delete(win));
			}
		}
		// Apply this frame's geometry immediately. Core Animation would otherwise
		// animate each frame/radius change on its own clock, so the native glass
		// trails the web morph and reads as a second layer behind it.
		const transaction = bridge.getClass("CATransaction");
		bridge.sendVoid(transaction, selector("begin"));
		bridge.sendBoolArg(transaction, selector("setDisableActions:"), true);
		try {
			updateGlassSurfaces(bridge, glass, state, mask);
		} finally {
			bridge.sendVoid(transaction, selector("commit"));
		}
		return true;
	} catch (error) {
		process.stderr.write(`Island Liquid Glass failed: ${String(error)}\n`);
		removeGlassState(win, bridge);
		glassFailed.add(win);
		return false;
	}
}

function updateGlassSurfaces(
	bridge: MacBridge,
	glass: LiquidGlass,
	state: GlassState,
	mask: MaterialMask
): void {
	const selector = (name: string) => bridge.registerSelector(name);
	for (let index = 0; index < mask.shapes.length; index += 1) {
		const contour = mask.shapes[index];
		let surface = state.surfaces[index];
		if (!surface) {
			surface = addGlassSurface(
				bridge,
				glass,
				state.root,
				mask.height,
				contour
			);
			state.surfaces.push(surface);
		}
		updateGlassSurface(bridge, surface, mask.height, state.root, contour);
	}
	for (
		let index = mask.shapes.length;
		index < state.surfaces.length;
		index += 1
	) {
		bridge.sendBoolArg(
			state.surfaces[index].container,
			selector("setHidden:"),
			true
		);
	}
}

function applyMacMask(win: BrowserWindow, mask: MaterialMask): boolean {
	const bridge = getMacBridge();
	if (!bridge) {
		return false;
	}
	let image: NativePointer = null;
	try {
		const selector = (name: string) => bridge.registerSelector(name);
		const view =
			bridge.koffi.address(
				bridge.koffi.decode(win.getNativeWindowHandle(), "void *")
			) || null;
		const window = bridge.sendObject(view, selector("window"));
		const effect = bridge.sendObject(window, selector("vibrantView"));
		if (!(window && effect)) {
			return false;
		}

		image = createMacMaskImage(bridge, mask);
		if (!image) {
			return false;
		}

		bridge.sendVoidArg(effect, selector("setMaskImage:"), image);
		const cornerMaskSelector = selector("setCornerMask:");
		if (
			bridge.sendBool(
				window,
				selector("respondsToSelector:"),
				cornerMaskSelector
			)
		) {
			bridge.sendVoidArg(window, cornerMaskSelector, image);
		}

		const previous = retainedMacImages.get(win);
		retainedMacImages.set(win, image);
		releaseMacImage(bridge, previous ?? null);
		if (!cleanupRegistered.has(win)) {
			cleanupRegistered.add(win);
			win.once("closed", () => {
				const retained = retainedMacImages.get(win);
				if (retained) {
					releaseMacImage(bridge, retained);
					retainedMacImages.delete(win);
				}
			});
		}
		return true;
	} catch {
		releaseMacImage(bridge, image);
		return false;
	}
}

/** Clip the actual OS material to the same rounded surfaces as GlassScrimCard. */
export function applyMaterialMask(
	win: BrowserWindow,
	width: number,
	height: number,
	contours: readonly IslandMaterialContour[]
): boolean {
	const mask = normalizeMaterialMask(width, height, contours);
	if (!mask || win.isDestroyed()) {
		return false;
	}
	if (process.platform === "win32") {
		try {
			win.setShape(materialMaskRects(mask));
			appliedWindows.add(win);
			return true;
		} catch {
			win.setBackgroundMaterial("none");
			return false;
		}
	}
	if (process.platform === "darwin") {
		if (getLiquidGlass() && !glassFailed.has(win)) {
			const appliedGlass = applyMacLiquidGlassMask(win, mask);
			if (appliedGlass) {
				appliedWindows.add(win);
				return true;
			}
			if (!fallbackVibrancy.has(win)) {
				win.setVibrancy("sidebar");
				fallbackVibrancy.add(win);
			}
		}
		const applied = applyMacMask(win, mask);
		if (applied) {
			appliedWindows.add(win);
		} else {
			// A clear window is preferable to an unmasked vibrancy rectangle.
			win.setVibrancy(null);
		}
		return applied;
	}
	return false;
}

export function hasMaterialMask(win: BrowserWindow): boolean {
	return appliedWindows.has(win);
}
