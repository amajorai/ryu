import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// Both live-activity stylesheets are global (the dock's is loaded with the
// workbench), so a physical border rule in either one tints the sidebar card's
// trailing edge under a right-to-left root. The accent belongs to
// LiveActivitiesSection.css, on the inline-start border only.
describe("LiveActivityDock.css", () => {
	test("sets no physical left or right border colour", () => {
		const css = readFileSync(
			new URL("./LiveActivityDock.css", import.meta.url),
			{ encoding: "utf8" }
		);
		expect(css).not.toMatch(/border-(left|right)/);
		expect(css).not.toContain("[data-live-activity-border]");
	});
});
