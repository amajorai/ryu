// The pure rules behind the Interface mode switch. Kept separate from the
// browser story (`e2e/interface-level-story.spec.ts`, which covers the switch,
// gradient and writes) because these are the parts that decide what the
// composer shows, and they regress silently: a level added
// in the middle, or a gate flipped to `!==`, still typechecks and still renders
// the UI.

import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}

import { beforeEach, describe, expect, it } from "bun:test";
import {
	readBotTerminology,
	setBotTerminology,
} from "@ryu/ui/hooks/use-bot-terminology.ts";
import {
	DEFAULT_SIDEBAR_MODE,
	SIDEBAR_MODE_KEY,
	setSidebarMode,
} from "@/src/hooks/useSidebarMode.ts";
import {
	DEFAULT_INTERFACE_LEVEL,
	INTERFACE_LEVEL_KEY,
	INTERFACE_LEVELS,
	type InterfaceLevel,
	interfaceLevelIndex,
	seedInterfaceLevel,
	setInterfaceLevel,
	showsComposerTuning,
	showsModelPicker,
} from "./interface-level.ts";

const IDS = INTERFACE_LEVELS.map((l) => l.id);

describe("the binary mode", () => {
	it("defaults to the least surface, which is the first switch position", () => {
		expect(DEFAULT_INTERFACE_LEVEL).toBe("simple");
		expect(interfaceLevelIndex(DEFAULT_INTERFACE_LEVEL)).toBe(0);
	});

	it("keeps the internal ids and exact user-facing labels", () => {
		expect(IDS).toEqual(["simple", "expert"]);
		expect(INTERFACE_LEVELS.map((level) => level.label)).toEqual([
			"Ryu Work",
			"Code",
		]);
	});

	it("gives each mode a distinct switch position", () => {
		const indexes = IDS.map((id) => interfaceLevelIndex(id));
		expect(new Set(indexes).size).toBe(IDS.length);
		expect(Math.max(...indexes)).toBe(IDS.length - 1);
	});

	it("parks an unknown mode on the first position rather than -1", () => {
		// -1 would render a switch with no active position; the floor is load-bearing.
		// SAFETY: Deliberately invalid input exercises the index fallback;
		// the asserted value is confined to this runtime rejection test.
		expect(interfaceLevelIndex("nonsense" as InterfaceLevel)).toBe(0);
	});
});

describe("what the composer shows", () => {
	it("hides the model picker only at Ryu Work", () => {
		expect(showsModelPicker("simple")).toBe(false);
		expect(showsModelPicker("expert")).toBe(true);
	});

	it("shows approval / thinking / style in Code", () => {
		expect(showsComposerTuning("simple")).toBe(false);
		expect(showsComposerTuning("expert")).toBe(true);
	});

	it("never offers tuning without the model it tunes", () => {
		// Approval mode and thinking budget describe how a MODEL is driven, so a
		// level that surfaced them while hiding the model would read as broken.
		for (const id of IDS) {
			if (showsComposerTuning(id)) {
				expect(showsModelPicker(id)).toBe(true);
			}
		}
	});

	it("only ever adds surface as the level rises", () => {
		const model = IDS.map((id) => showsModelPicker(id));
		const tuning = IDS.map((id) => showsComposerTuning(id));
		for (let i = 1; i < IDS.length; i++) {
			expect(model[i] || !model[i - 1]).toBe(true);
			expect(tuning[i] || !tuning[i - 1]).toBe(true);
		}
	});
});

describe("interface level vocabulary preset", () => {
	beforeEach(() => {
		localStorage.clear();
		setInterfaceLevel("expert", { applyPrefs: false });
		setBotTerminology(true);
	});

	it("forces Bot terminology on when Ryu Work is selected", () => {
		setBotTerminology(false);
		setSidebarMode("sections");

		setInterfaceLevel("simple");

		expect(readBotTerminology()).toBe(true);
		expect(localStorage.getItem(SIDEBAR_MODE_KEY)).toBe(DEFAULT_SIDEBAR_MODE);
	});

	it("preserves an explicit choice in Code", () => {
		setBotTerminology(false);
		setSidebarMode("sections");

		setInterfaceLevel("expert");

		expect(readBotTerminology()).toBe(false);
		expect(localStorage.getItem(SIDEBAR_MODE_KEY)).toBe("sections");
	});

	it("repairs an older stored Ryu Work selection on boot", () => {
		localStorage.setItem(INTERFACE_LEVEL_KEY, "simple");
		localStorage.setItem(SIDEBAR_MODE_KEY, "sections");
		setBotTerminology(false);

		seedInterfaceLevel();

		expect(readBotTerminology()).toBe(true);
		expect(localStorage.getItem(SIDEBAR_MODE_KEY)).toBe(DEFAULT_SIDEBAR_MODE);
	});

	it("seeds Bot mode for a fresh Ryu Work install", () => {
		localStorage.removeItem(INTERFACE_LEVEL_KEY);

		seedInterfaceLevel();

		expect(localStorage.getItem(SIDEBAR_MODE_KEY)).toBe(DEFAULT_SIDEBAR_MODE);
	});

	it("migrates old intermediate detents to Code and applies Code prefs", () => {
		localStorage.setItem(INTERFACE_LEVEL_KEY, "standard");
		setBotTerminology(false);

		seedInterfaceLevel();

		expect(localStorage.getItem(INTERFACE_LEVEL_KEY)).toBe("expert");
		expect(localStorage.getItem("ryu:hide-tool-detail")).toBe("false");
		expect(localStorage.getItem("ryu:expand-commands")).toBe("true");
		expect(localStorage.getItem("ryu:inference-stats")).toBe("true");
		expect(readBotTerminology()).toBe(false);
	});
});
