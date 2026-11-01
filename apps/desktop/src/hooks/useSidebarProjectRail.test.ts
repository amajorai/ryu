import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}

import { beforeEach, describe, expect, test } from "bun:test";
import {
	readRailProject,
	SIDEBAR_RAIL_PROJECT_KEY,
	setRailProject,
} from "./useSidebarProjectRail.ts";

beforeEach(() => {
	localStorage.clear();
});

describe("project rail focus", () => {
	test("starts at Home", () => {
		expect(readRailProject()).toBeNull();
	});

	test("persists a focused project and clears back to Home", () => {
		setRailProject("/work/alpha");
		expect(localStorage.getItem(SIDEBAR_RAIL_PROJECT_KEY)).toBe("/work/alpha");
		expect(readRailProject()).toBe("/work/alpha");
		setRailProject(null);
		expect(localStorage.getItem(SIDEBAR_RAIL_PROJECT_KEY)).toBeNull();
		expect(readRailProject()).toBeNull();
	});

	test("treats an empty stored value as Home", () => {
		localStorage.setItem(SIDEBAR_RAIL_PROJECT_KEY, "");
		expect(readRailProject()).toBeNull();
	});
});
