import { afterEach, describe, expect, test } from "bun:test";
import {
	interfaceParamsWithOverrides,
	resolveInterfaceParams,
} from "@ryuhq/protocol/interfaces";
import {
	createInterfaceSettingsStore,
	INTERFACE_SETTINGS_KEY,
	sanitizeOverrides,
} from "./use-interface-settings.ts";

const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

function memoryStorage(): Storage {
	const map = new Map<string, string>();
	return {
		clear: () => map.clear(),
		getItem: (key) => map.get(key) ?? null,
		key: (index) => [...map.keys()][index] ?? null,
		get length() {
			return map.size;
		},
		removeItem: (key) => {
			map.delete(key);
		},
		setItem: (key, value) => {
			map.set(key, value);
		},
	};
}

function throwingStorage(): Storage {
	const fail = () => {
		throw new Error("storage blocked");
	};
	return {
		clear: fail,
		getItem: fail,
		key: fail,
		length: 0,
		removeItem: fail,
		setItem: fail,
	};
}

function setStorage(storage: Storage) {
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: storage,
	});
}

afterEach(() => {
	if (original) {
		Object.defineProperty(globalThis, "localStorage", original);
	} else {
		Reflect.deleteProperty(globalThis, "localStorage");
	}
});

describe("useInterfaceSettings", () => {
	test("keeps each interface's overrides, merges patches and persists them", () => {
		const storage = memoryStorage();
		setStorage(storage);
		const store = createInterfaceSettingsStore();
		expect(store.getState().overrides).toEqual({});
		store.getState().setSettings("ryu:board", { view: "list" });
		store.getState().setSettings("ryu:board", { groupBy: "agent" });
		store.getState().setSettings("ryu:farm", { workBubbles: false });
		expect(store.getState().overrides).toEqual({
			"ryu:board": { groupBy: "agent", view: "list" },
			"ryu:farm": { workBubbles: false },
		});
		expect(JSON.parse(storage.getItem(INTERFACE_SETTINGS_KEY) ?? "{}")).toEqual(
			store.getState().overrides
		);
		expect(createInterfaceSettingsStore().getState().overrides).toEqual(
			store.getState().overrides
		);
	});

	test("reset forgets one interface only, and the last reset clears storage", () => {
		const storage = memoryStorage();
		setStorage(storage);
		const store = createInterfaceSettingsStore();
		store.getState().setSettings("ryu:board", { view: "list" });
		store.getState().setSettings("ryu:farm", { workBubbles: false });
		store.getState().resetSettings("ryu:board");
		expect(store.getState().overrides).toEqual({
			"ryu:farm": { workBubbles: false },
		});
		store.getState().resetSettings("ryu:farm");
		expect(storage.getItem(INTERFACE_SETTINGS_KEY)).toBeNull();
	});

	test("stored junk is dropped; storage failing still keeps the session's choice", () => {
		expect(
			sanitizeOverrides({
				"ryu:board": { view: "list", nested: { a: 1 }, long: "x".repeat(200) },
				"ryu:farm": "nope",
			})
		).toEqual({ "ryu:board": { view: "list" } });
		expect(sanitizeOverrides([1, 2])).toEqual({});
		const storage = memoryStorage();
		storage.setItem(INTERFACE_SETTINGS_KEY, "{not json");
		setStorage(storage);
		expect(createInterfaceSettingsStore().getState().overrides).toEqual({});
		setStorage(throwingStorage());
		const store = createInterfaceSettingsStore();
		store.getState().setSettings("ryu:board", { view: "list" });
		expect(store.getState().overrides["ryu:board"]).toEqual({ view: "list" });
	});

	test("the host's merge gives renderers the live params", () => {
		const descriptor = {
			params: { view: "list" },
			renderer: "board" as const,
		};
		const live = (overrides?: Record<string, string>) =>
			resolveInterfaceParams(
				"board",
				interfaceParamsWithOverrides(descriptor, overrides)
			);
		expect(live()).toEqual({ groupBy: "status", view: "list" });
		expect(live({ groupBy: "project", view: "board" })).toEqual({
			groupBy: "project",
			view: "board",
		});
	});
});
