import { describe, expect, test } from "bun:test";
import { acceleratorTokens, eventToAccelerator } from "./ShortcutCapture.tsx";

function press(
	code: string,
	key: string,
	modifiers: Partial<{
		altKey: boolean;
		ctrlKey: boolean;
		metaKey: boolean;
		shiftKey: boolean;
	}> = {}
) {
	return eventToAccelerator({
		altKey: false,
		code,
		ctrlKey: false,
		key,
		metaKey: false,
		shiftKey: false,
		...modifiers,
	});
}

describe("eventToAccelerator", () => {
	test("macOS Option+D names the physical key, not the composed character", () => {
		expect(press("KeyD", "∂", { altKey: true })).toBe("Alt+D");
	});

	test("Option+Space is Space, not a non-breaking space", () => {
		expect(press("Space", " ", { altKey: true })).toBe("Alt+Space");
	});

	test("Shift+= keeps Shift as a modifier and the unshifted key", () => {
		expect(press("Equal", "+", { metaKey: true, shiftKey: true })).toBe(
			"CommandOrControl+Shift+="
		);
	});

	test("a dead key on a physical letter records that letter", () => {
		expect(press("KeyE", "Dead", { altKey: true })).toBe("Alt+E");
	});

	test("keys with no accelerator name are rejected", () => {
		expect(press("IntlBackslash", "Dead", { altKey: true })).toBeNull();
		expect(press("", "∂", { altKey: true })).toBeNull();
	});

	test("modifier-only presses keep capturing", () => {
		expect(press("ShiftLeft", "Shift", { shiftKey: true })).toBeNull();
	});

	test("digits, function, arrow and numpad keys map to Electron names", () => {
		expect(press("Digit2", "@", { shiftKey: true })).toBe("Shift+2");
		expect(press("F12", "F12")).toBe("F12");
		expect(press("ArrowUp", "ArrowUp", { ctrlKey: true })).toBe(
			"CommandOrControl+Up"
		);
		expect(press("Numpad7", "7")).toBe("num7");
	});

	test("lock, print-screen, numpad-operator and media keys stay selectable", () => {
		expect(press("PrintScreen", "PrintScreen")).toBe("PrintScreen");
		expect(press("CapsLock", "CapsLock")).toBe("Capslock");
		expect(press("NumLock", "NumLock")).toBe("Numlock");
		expect(press("ScrollLock", "ScrollLock")).toBe("Scrolllock");
		expect(press("NumpadAdd", "+")).toBe("numadd");
		expect(press("NumpadDecimal", ".")).toBe("numdec");
		expect(press("MediaPlayPause", "MediaPlayPause")).toBe("MediaPlayPause");
		expect(press("MediaTrackNext", "MediaTrackNext")).toBe("MediaNextTrack");
		expect(press("AudioVolumeUp", "AudioVolumeUp")).toBe("VolumeUp");
	});

	test("events without a physical code fall back to named and ASCII keys", () => {
		expect(press("", " ", { ctrlKey: true, shiftKey: true })).toBe(
			"CommandOrControl+Shift+Space"
		);
		expect(press("", "ArrowUp", { altKey: true })).toBe("Alt+Up");
		expect(press("", "Enter")).toBe("Return");
		expect(press("", "Tab", { ctrlKey: true })).toBe("CommandOrControl+Tab");
		expect(press("", "PageDown")).toBe("PageDown");
		expect(press("", "F5")).toBe("F5");
		expect(press("", "k", { ctrlKey: true })).toBe("CommandOrControl+K");
		expect(press("", ";")).toBe(";");
		expect(press("", "+", { ctrlKey: true })).toBe("CommandOrControl+Plus");
		expect(press("", "Dead")).toBeNull();
		expect(press("", "Unidentified")).toBeNull();
		expect(press("", "é")).toBeNull();
	});
});

describe("acceleratorTokens", () => {
	test("labels Plus and keeps a literal + main key as one keycap", () => {
		expect(acceleratorTokens("CommandOrControl+Plus")).toEqual(["Ctrl", "+"]);
		expect(acceleratorTokens("CommandOrControl+Shift++")).toEqual([
			"Ctrl",
			"Shift",
			"+",
		]);
		expect(acceleratorTokens("Alt+Space")).toEqual(["Alt", "Space"]);
	});
});
