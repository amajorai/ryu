import { describe, expect, it } from "bun:test";
import { DESKTOP_HOTKEYS } from "./actions.ts";

describe("Desktop settings dialog shortcuts", () => {
	const settings = DESKTOP_HOTKEYS.find(
		(action) => action.id === "settings.open"
	);
	const gateway = DESKTOP_HOTKEYS.find(
		(action) => action.id === "gateway.open"
	);

	it("declares distinct platform-aware defaults for both dialogs", () => {
		expect(settings?.label).toBe("Open Settings");
		expect(settings?.category).toBe("General");
		expect(settings?.defaultBinding).toBe("Mod+.");

		expect(gateway?.label).toBe("Open Gateway Settings");
		expect(gateway?.category).toBe("General");
		expect(gateway?.defaultBinding).toBe("Mod+,");

		expect(
			new Set([settings?.defaultBinding, gateway?.defaultBinding]).size
		).toBe(2);
	});
});

describe("chat search shortcut", () => {
	it("opens and cycles the focused chat's message and file search", () => {
		const search = DESKTOP_HOTKEYS.find(
			(action) => action.id === "chat.search"
		);

		expect(search?.label).toBe("Search Chat or Files");
		expect(search?.category).toBe("Chat");
		expect(search?.defaultBinding).toBe("Mod+F");
		expect(search?.description).toMatch(
			/between chat messages and project files/
		);
	});
});
