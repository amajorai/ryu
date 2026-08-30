import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}

import { beforeEach, describe, expect, test } from "bun:test";
import { readTabViewMode, writeTabViewMode } from "./useTabViewMode.ts";

const STORAGE_KEY = "ryu:test-view-modes";
const MODES = ["grid", "list", "showcase"] as const;

beforeEach(() => {
	localStorage.clear();
});

describe("tab view mode persistence", () => {
	test("uses the supplied default when a tab has no preference", () => {
		expect(
			readTabViewMode({
				defaultMode: "showcase",
				storageKey: STORAGE_KEY,
				tabKey: "agents",
				validModes: MODES,
			})
		).toBe("showcase");
	});

	test("keeps each tab's selection independent", () => {
		writeTabViewMode(STORAGE_KEY, "agents", "list");
		writeTabViewMode(STORAGE_KEY, "spaces", "showcase");

		expect(
			readTabViewMode({
				defaultMode: "showcase",
				storageKey: STORAGE_KEY,
				tabKey: "agents",
				validModes: MODES,
			})
		).toBe("list");
		expect(
			readTabViewMode({
				defaultMode: "grid",
				storageKey: STORAGE_KEY,
				tabKey: "spaces",
				validModes: MODES,
			})
		).toBe("showcase");
	});

	test("reads the old single-value preference during migration", () => {
		localStorage.setItem(STORAGE_KEY, "list");
		expect(
			readTabViewMode({
				defaultMode: "showcase",
				storageKey: STORAGE_KEY,
				tabKey: "agents",
				validModes: MODES,
			})
		).toBe("list");
	});

	test("ignores invalid stored modes", () => {
		localStorage.setItem(STORAGE_KEY, JSON.stringify({ agents: "canvas" }));
		expect(
			readTabViewMode({
				defaultMode: "showcase",
				storageKey: STORAGE_KEY,
				tabKey: "agents",
				validModes: MODES,
			})
		).toBe("showcase");
	});
});
