import { createRequire } from "node:module";
import { screen } from "electron";
import { z } from "zod";

const safeAreaSchema = z.object({ top: z.number() });
const auxiliaryAreaSchema = z.object({ width: z.number() });

import type { NotchGeometry } from "../shared/notch.ts";

const require = createRequire(import.meta.url);
let enabled = false;
let geometry: NotchGeometry | null = null;
export function isNotchModeEnabled(): boolean {
	return enabled;
}
export function getNotchGeometry(): NotchGeometry | null {
	return enabled ? geometry : null;
}
export function setNotchMode(value: boolean): void {
	enabled = value;
	refreshNotchGeometry();
}
/** NSScreen safe areas distinguish a camera cutout from an ordinary menu bar. */
export function refreshNotchGeometry(): void {
	geometry = null;
	if (!enabled || process.platform !== "darwin") {
		return;
	}
	try {
		// SAFETY: This guarded require loads the optional Koffi package by name,
		// whose installed declarations own its library and struct binding APIs.
		const koffi = require("koffi") as typeof import("koffi");
		koffi.load("/System/Library/Frameworks/AppKit.framework/AppKit");
		const objc = koffi.load("/usr/lib/libobjc.A.dylib");
		const cls = objc.func("void *objc_getClass(const char *)");
		const sel = objc.func("void *sel_registerName(const char *)");
		const obj = objc.func("void *objc_msgSend(void *, void *)");
		const at = objc.func("void *objc_msgSend(void *, void *, unsigned long)");
		const count = objc.func("unsigned long objc_msgSend(void *, void *)");
		const arg = objc.func("void *objc_msgSend(void *, void *, void *)");
		const str = objc.func("void *objc_msgSend(void *, void *, const char *)");
		const responds = objc.func("bool objc_msgSend(void *, void *, void *)");
		const rectType = koffi.struct({
			x: "double",
			y: "double",
			width: "double",
			height: "double",
		});
		const insetsType = koffi.struct({
			top: "double",
			left: "double",
			bottom: "double",
			right: "double",
		});
		// Intel returns large structs through objc_msgSend_stret; arm64 uses msgSend.
		const symbol =
			process.arch === "x64" ? "objc_msgSend_stret" : "objc_msgSend";
		const rect = objc.func(symbol, rectType, ["void *", "void *"]);
		const insets = objc.func(symbol, insetsType, ["void *", "void *"]);
		const screens = obj(cls("NSScreen"), sel("screens"));
		for (let index = 0; index < count(screens, sel("count")); index++) {
			const native = at(screens, sel("objectAtIndex:"), index);
			if (
				!responds(native, sel("respondsToSelector:"), sel("safeAreaInsets"))
			) {
				continue;
			}
			const parsedSafe = safeAreaSchema.safeParse(
				insets(native, sel("safeAreaInsets"))
			);
			if (!parsedSafe.success) {
				continue;
			}
			const safe = parsedSafe.data;
			if (!Number.isFinite(safe.top) || safe.top <= 0 || safe.top > 100) {
				continue;
			}
			const description = obj(native, sel("deviceDescription"));
			const key = str(
				cls("NSString"),
				sel("stringWithUTF8String:"),
				"NSScreenNumber"
			);
			const number = arg(description, sel("objectForKey:"), key);
			const id = count(number, sel("unsignedIntValue"));
			const display = screen.getAllDisplays().find((item) => item.id === id);
			if (!display) {
				continue;
			}
			const parsedLeft = auxiliaryAreaSchema.safeParse(
				rect(native, sel("auxiliaryTopLeftArea"))
			);
			const parsedRight = auxiliaryAreaSchema.safeParse(
				rect(native, sel("auxiliaryTopRightArea"))
			);
			if (!(parsedLeft.success && parsedRight.success)) {
				continue;
			}
			const left = parsedLeft.data;
			const right = parsedRight.data;
			const width = display.bounds.width - left.width - right.width;
			if (
				!Number.isFinite(width) ||
				width <= 0 ||
				width > display.bounds.width / 2
			) {
				continue;
			}
			geometry = {
				displayId: id,
				width,
				height: safe.top,
				x: display.bounds.x + left.width,
				y: display.bounds.y,
			};
			break;
		}
	} catch (error) {
		console.warn(
			"[island] Notch detection unavailable; using floating mode",
			error
		);
	}
}
