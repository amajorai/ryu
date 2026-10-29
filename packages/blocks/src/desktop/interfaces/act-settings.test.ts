import { describe, expect, test } from "bun:test";
import { keepsActOverlay } from "./act-settings.ts";
import { GAME_KIT_DEFAULTS } from "./game3d-settings.tsx";

describe("keepsActOverlay", () => {
	const ids = [
		"work:cy",
		"ask:bo",
		"progress:cy",
		"next:cy",
		"elapsed:cy",
		"limit:fa",
		"cue:io",
		"done:gu",
	];
	const kept = (settings: typeof GAME_KIT_DEFAULTS) =>
		ids.filter((id) => keepsActOverlay({ id }, settings));

	test("the defaults keep every overlay", () => {
		expect(kept(GAME_KIT_DEFAULTS)).toEqual(ids);
	});

	test("work bubbles off drops only the work bubbles", () => {
		expect(kept({ ...GAME_KIT_DEFAULTS, workBubbles: false })).toEqual(
			ids.filter((id) => id !== "work:cy")
		);
	});

	test("minimal density drops progress, elapsed and next lines; limits and cues stay", () => {
		expect(kept({ ...GAME_KIT_DEFAULTS, overlayDensity: "minimal" })).toEqual([
			"work:cy",
			"ask:bo",
			"limit:fa",
			"cue:io",
			"done:gu",
		]);
	});
});
