import { describe, expect, test } from "bun:test";
import { resolvePlusMenu } from "./composer-toolbar.tsx";

const noop = () => undefined;

const plusMenuInputs = {
	directoryGroups: [
		{
			id: "apps",
			items: [{ id: "calendar", label: "Calendar" }],
			label: "Apps",
		},
	],
	hasImageGen: true,
	hasInput: true,
	hasVideoGen: true,
	isStreaming: false,
	onGenerateImage: noop,
	onGenerateVideo: noop,
	showAttach: true,
};

describe("resolvePlusMenu", () => {
	test("offers generation and directory rows while the composer is a text field", () => {
		const menu = resolvePlusMenu(plusMenuInputs);
		expect(menu.imageGen?.disabled).toBe(false);
		expect(menu.videoGen?.disabled).toBe(false);
		expect(menu.directoryGroups).toHaveLength(1);
		expect(menu.showDirectory).toBe(true);
		expect(menu.showPlusMenu).toBe(true);
	});

	test("withholds rows that read or rewrite the hidden draft during a live call", () => {
		const menu = resolvePlusMenu({ ...plusMenuInputs, inLiveCall: true });
		expect(menu.imageGen).toBeUndefined();
		expect(menu.videoGen).toBeUndefined();
		expect(menu.directoryGroups).toBeUndefined();
		expect(menu.showDirectory).toBe(false);
		// Attach still opens the menu, so files can be staged during the call.
		expect(menu.showPlusMenu).toBe(true);
	});
});
