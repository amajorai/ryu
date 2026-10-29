import { afterEach, describe, expect, test } from "bun:test";
import {
	createInterfacePrefsStore,
	HIDE_WORK_DETAILS_KEY,
} from "./use-interface-prefs.ts";

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

describe("useInterfacePrefs", () => {
	test("defaults off and persists across a store re-create", () => {
		const storage = memoryStorage();
		setStorage(storage);
		const store = createInterfacePrefsStore();
		expect(store.getState().hideWorkDetails).toBe(false);
		store.getState().setHideWorkDetails(true);
		expect(storage.getItem(HIDE_WORK_DETAILS_KEY)).toBe("1");
		expect(createInterfacePrefsStore().getState().hideWorkDetails).toBe(true);
		store.getState().setHideWorkDetails(false);
		expect(createInterfacePrefsStore().getState().hideWorkDetails).toBe(false);
	});

	test("with storage throwing it reads false and still toggles for the session", () => {
		setStorage(throwingStorage());
		const store = createInterfacePrefsStore();
		expect(store.getState().hideWorkDetails).toBe(false);
		store.getState().setHideWorkDetails(true);
		expect(store.getState().hideWorkDetails).toBe(true);
	});
});
