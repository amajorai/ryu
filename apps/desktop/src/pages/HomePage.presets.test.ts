import { describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { LiteralMessage } from "@ryu/i18n/react";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
const { localizedPresetInput, PRESETS } = await import("./HomePage.presets.ts");

const tl: LiteralMessage = (source) => `[${source}]`;

function preset(label: string) {
	const found = PRESETS.find((candidate) => candidate.label === label);
	if (!found) {
		throw new Error(`missing preset ${label}`);
	}
	return found;
}

describe("localizedPresetInput", () => {
	test("the starter note's stored copy is worded by the translator", () => {
		const note = localizedPresetInput(preset("Note"), tl);
		expect(note.title).toBe("[Note]");
		expect(note.config).toEqual({
			markdown: "[Welcome to your Home dashboard. Edit me.]",
		});
		expect("label" in note).toBe(false);
	});

	test("a metric preset keeps its config and translates its title", () => {
		const monitors = localizedPresetInput(preset("Monitors"), tl);
		expect(monitors.title).toBe("[Monitors]");
		expect(monitors.source).toEqual(preset("Monitors").source);
	});
});
