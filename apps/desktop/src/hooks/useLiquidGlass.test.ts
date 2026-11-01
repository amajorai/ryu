import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { SETTINGS_REMOTE_APPLIED_EVENT } from "../lib/settings-sync/local-store.ts";
import {
	applyLiquidGlassAttribute,
	DEFAULT_LIQUID_GLASS,
	initLiquidGlass,
	LIQUID_GLASS_ATTRIBUTE,
	LIQUID_GLASS_KEY,
	readLiquidGlassPreference,
	SET_LIQUID_GLASS_COMMAND,
	setLiquidGlass,
} from "./useLiquidGlass.ts";

const invokeCalls: Array<{ command: string; args: unknown }> = [];

// Stand in for the bridge Tauri injects, rather than mocking the ready-gate
// module: bun shares module mocks across every file in one run.
Reflect.set(window, "__TAURI_INTERNALS__", {
	invoke: (command: string, args: unknown) => {
		invokeCalls.push({ command, args });
		return Promise.resolve();
	},
	transformCallback: () => 0,
});

afterAll(() => {
	Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

const root = () => document.documentElement;

beforeEach(() => {
	localStorage.clear();
	root().removeAttribute(LIQUID_GLASS_ATTRIBUTE);
	invokeCalls.length = 0;
});

describe("Liquid Glass preference", () => {
	test("ships enabled under the shared contract key", () => {
		expect(DEFAULT_LIQUID_GLASS).toBe(true);
		expect(LIQUID_GLASS_KEY).toBe("ryu:liquid-glass");
		expect(LIQUID_GLASS_ATTRIBUTE).toBe("data-ryu-liquid-glass");
		expect(SET_LIQUID_GLASS_COMMAND).toBe("set_liquid_glass");
	});

	test("treats a missing value as enabled", () => {
		expect(readLiquidGlassPreference()).toBe(true);
		localStorage.setItem(LIQUID_GLASS_KEY, "false");
		expect(readLiquidGlassPreference()).toBe(false);
	});

	test("marks the root only while disabled", () => {
		applyLiquidGlassAttribute(false);
		expect(root().getAttribute(LIQUID_GLASS_ATTRIBUTE)).toBe("off");

		applyLiquidGlassAttribute(true);
		expect(root().hasAttribute(LIQUID_GLASS_ATTRIBUTE)).toBe(false);
	});

	test("startup applies the persisted choice and tells the native shell", () => {
		localStorage.setItem(LIQUID_GLASS_KEY, "false");

		initLiquidGlass();

		expect(root().getAttribute(LIQUID_GLASS_ATTRIBUTE)).toBe("off");
		expect(invokeCalls).toEqual([
			{ command: "set_liquid_glass", args: { enabled: false } },
		]);
	});

	test("the setter persists, applies and syncs every change", () => {
		setLiquidGlass(false);
		expect(localStorage.getItem(LIQUID_GLASS_KEY)).toBe("false");
		expect(root().getAttribute(LIQUID_GLASS_ATTRIBUTE)).toBe("off");

		setLiquidGlass(true);
		expect(localStorage.getItem(LIQUID_GLASS_KEY)).toBe("true");
		expect(root().hasAttribute(LIQUID_GLASS_ATTRIBUTE)).toBe(false);

		expect(invokeCalls).toEqual([
			{ command: "set_liquid_glass", args: { enabled: false } },
			{ command: "set_liquid_glass", args: { enabled: true } },
		]);
	});

	test("a settings-sync write in this window re-applies the choice", () => {
		initLiquidGlass();
		invokeCalls.length = 0;

		localStorage.setItem(LIQUID_GLASS_KEY, "false");
		window.dispatchEvent(
			new CustomEvent(SETTINGS_REMOTE_APPLIED_EVENT, {
				detail: { key: LIQUID_GLASS_KEY },
			})
		);

		expect(root().getAttribute(LIQUID_GLASS_ATTRIBUTE)).toBe("off");
		expect(invokeCalls).toEqual([
			{ command: "set_liquid_glass", args: { enabled: false } },
		]);
	});
});
