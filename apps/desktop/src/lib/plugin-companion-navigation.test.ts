import { describe, expect, test } from "bun:test";
import { isNavigablePluginCompanion } from "./plugin-companion-navigation.ts";

describe("companion navigation", () => {
	test("global and legacy companions remain launchable", () => {
		expect(
			isNavigablePluginCompanion({ hasUi: true, navigationVisible: true })
		).toBe(true);
		expect(isNavigablePluginCompanion({ hasUi: true })).toBe(true);
	});

	test("file and thread companions remain available to routing but leave global navigation", () => {
		const contextual = { id: "editor", hasUi: true, navigationVisible: false };
		const global = { id: "home", hasUi: true, navigationVisible: true };
		const companions = [contextual, global];
		expect(
			companions.filter(isNavigablePluginCompanion).map((entry) => entry.id)
		).toEqual(["home"]);
		expect(companions.find((entry) => entry.id === "editor")).toBe(contextual);
		expect(companions.filter(isNavigablePluginCompanion).find(() => true)).toBe(
			global
		);
	});

	test("a declared global entry without UI is not launchable", () => {
		expect(
			isNavigablePluginCompanion({ hasUi: false, navigationVisible: true })
		).toBe(false);
	});
});
