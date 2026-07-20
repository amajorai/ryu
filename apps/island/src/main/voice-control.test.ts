import { describe, expect, it } from "bun:test";
import { UiohookKey } from "uiohook-napi";
import { acceleratorPrimaryKeycode } from "./voice-control.ts";

describe("acceleratorPrimaryKeycode", () => {
	it("maps the default push-to-talk chord to its letter key", () => {
		expect(acceleratorPrimaryKeycode("CommandOrControl+Shift+A")).toBe(
			UiohookKey.A
		);
	});

	it("takes the last (non-modifier) token as the primary key", () => {
		expect(acceleratorPrimaryKeycode("Alt+Shift+5")).toBe(UiohookKey["5"]);
		expect(acceleratorPrimaryKeycode("Control+F5")).toBe(UiohookKey.F5);
	});

	it("is case-insensitive on the primary letter", () => {
		expect(acceleratorPrimaryKeycode("Ctrl+b")).toBe(UiohookKey.B);
	});

	it("maps named keys through the alias table", () => {
		expect(acceleratorPrimaryKeycode("CommandOrControl+Space")).toBe(
			UiohookKey.Space
		);
		expect(acceleratorPrimaryKeycode("Alt+Enter")).toBe(UiohookKey.Enter);
		expect(acceleratorPrimaryKeycode("Ctrl+Up")).toBe(UiohookKey.ArrowUp);
	});

	it("maps punctuation primary keys", () => {
		expect(acceleratorPrimaryKeycode("Control+/")).toBe(UiohookKey.Slash);
	});

	it("returns null for an unmappable key (caller falls back to toggle)", () => {
		expect(acceleratorPrimaryKeycode("CommandOrControl+VolumeUp")).toBeNull();
		expect(acceleratorPrimaryKeycode("")).toBeNull();
	});
});
