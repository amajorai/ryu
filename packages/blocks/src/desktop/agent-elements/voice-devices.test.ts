import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	DEFAULT_MIC_KEY,
	DEFAULT_SPEAKER_KEY,
	getDefaultMicId,
	getDefaultSpeakerId,
	setDefaultMicId,
	setDefaultSpeakerId,
} from "./voice-devices.ts";

interface StorageLike {
	getItem(key: string): string | null;
	removeItem(key: string): void;
	setItem(key: string, value: string): void;
}

function makeStorage(): StorageLike {
	const map = new Map<string, string>();
	return {
		getItem: (k) => map.get(k) ?? null,
		setItem: (k, v) => {
			map.set(k, v);
		},
		removeItem: (k) => {
			map.delete(k);
		},
	};
}

const globalWithStorage = globalThis as { localStorage?: unknown };
const originalStorage = globalWithStorage.localStorage;

afterEach(() => {
	globalWithStorage.localStorage = originalStorage;
});

describe("mic + speaker preference persistence", () => {
	beforeEach(() => {
		globalWithStorage.localStorage = makeStorage();
	});

	it("returns null when nothing is stored", () => {
		expect(getDefaultMicId()).toBeNull();
		expect(getDefaultSpeakerId()).toBeNull();
	});

	it("round-trips a saved mic id under the documented key", () => {
		setDefaultMicId("mic-42");
		expect(getDefaultMicId()).toBe("mic-42");
		expect(
			(globalWithStorage.localStorage as StorageLike).getItem(DEFAULT_MIC_KEY)
		).toBe("mic-42");
	});

	it("round-trips a saved speaker id under the documented key", () => {
		setDefaultSpeakerId("spk-7");
		expect(getDefaultSpeakerId()).toBe("spk-7");
		expect(
			(globalWithStorage.localStorage as StorageLike).getItem(
				DEFAULT_SPEAKER_KEY
			)
		).toBe("spk-7");
	});

	it("clears the stored value when set to null (system default)", () => {
		setDefaultMicId("mic-1");
		setDefaultMicId(null);
		expect(getDefaultMicId()).toBeNull();
	});

	it("mic and speaker preferences are stored independently", () => {
		setDefaultMicId("m");
		setDefaultSpeakerId("s");
		expect(getDefaultMicId()).toBe("m");
		expect(getDefaultSpeakerId()).toBe("s");
	});
});

describe("resilience when storage is unavailable", () => {
	beforeEach(() => {
		const throwing: StorageLike = {
			getItem: () => {
				throw new Error("no storage");
			},
			setItem: () => {
				throw new Error("no storage");
			},
			removeItem: () => {
				throw new Error("no storage");
			},
		};
		globalWithStorage.localStorage = throwing;
	});

	it("reads fall back to null instead of throwing", () => {
		expect(() => getDefaultMicId()).not.toThrow();
		expect(getDefaultMicId()).toBeNull();
	});

	it("writes swallow the error instead of throwing", () => {
		expect(() => setDefaultMicId("x")).not.toThrow();
		expect(() => setDefaultSpeakerId(null)).not.toThrow();
	});
});
