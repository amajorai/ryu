import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}

import { beforeEach, describe, expect, test } from "bun:test";
import { initChromeShadows } from "./useChromeShadows.ts";
import {
	DEFAULT_SIDEBAR_VARIANT,
	readSidebarVariant,
	SIDEBAR_VARIANT_KEY,
	setSidebarVariant,
	sidebarFloatingChrome,
} from "./useSidebarVariant.ts";

beforeEach(() => {
	localStorage.clear();
	document.documentElement.removeAttribute("data-chrome-shadows");
});

describe("sidebar variant preference", () => {
	test("defaults to the floating sidebar", () => {
		expect(DEFAULT_SIDEBAR_VARIANT).toBe("floating");
		expect(readSidebarVariant()).toBe("floating");
	});

	test("keeps a stored inset choice and round-trips the setter", () => {
		localStorage.setItem(SIDEBAR_VARIANT_KEY, "inset");
		expect(readSidebarVariant()).toBe("inset");
		setSidebarVariant("floating");
		expect(readSidebarVariant()).toBe("floating");
	});

	test("treats unknown stored values as floating", () => {
		localStorage.setItem(SIDEBAR_VARIANT_KEY, "bogus");
		expect(readSidebarVariant()).toBe("floating");
	});

	test("floating chrome carries the gated drop shadow", () => {
		expect(sidebarFloatingChrome).toContain("ryu-chrome-shadow");
		expect(sidebarFloatingChrome).toContain("drop-shadow-2xl");
	});
});

describe("chrome shadows", () => {
	test("are on by default", () => {
		initChromeShadows();
		expect(document.documentElement.hasAttribute("data-chrome-shadows")).toBe(
			false
		);
	});

	test("keep a stored opt-out", () => {
		localStorage.setItem("ryu_chrome_shadows", "false");
		initChromeShadows();
		expect(document.documentElement.getAttribute("data-chrome-shadows")).toBe(
			"off"
		);
	});
});
