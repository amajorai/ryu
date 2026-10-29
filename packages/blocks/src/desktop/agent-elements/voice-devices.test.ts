import { requireTestValue } from "../test-required.ts";
/** Complete local navigator fixture carrier for these stop-only lifecycle
 * probes. It is deliberately not claimed to be a native MediaStream or a full
 * MediaDevices implementation; the production native SDK owner is unchanged. */
interface FixtureMicrophoneStream {
	getTracks(): { stop(): void }[];
}

import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import { isNativeFunction } from "@ryu/ui/lib/native-primitive-observation.ts";
import {
	DEFAULT_MIC_KEY,
	DEFAULT_SPEAKER_KEY,
	ensureMicPermission,
	getDefaultMicId,
	getDefaultSpeakerId,
	setDefaultMicId,
	setDefaultSpeakerId,
} from "./voice-devices.ts";

function makeStorage(): Storage {
	const map = new Map<string, string>();
	return {
		clear: () => map.clear(),
		key: (index) => [...map.keys()][index] ?? null,
		get length() {
			return map.size;
		},
		getItem: (k) => map.get(k) ?? null,
		setItem: (k, v) => {
			map.set(k, v);
		},
		removeItem: (k) => {
			map.delete(k);
		},
	};
}

const globalWithStorage = globalThis;
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
		expect(globalWithStorage.localStorage.getItem(DEFAULT_MIC_KEY)).toBe(
			"mic-42"
		);
	});

	it("round-trips a saved speaker id under the documented key", () => {
		setDefaultSpeakerId("spk-7");
		expect(getDefaultSpeakerId()).toBe("spk-7");
		expect(globalWithStorage.localStorage.getItem(DEFAULT_SPEAKER_KEY)).toBe(
			"spk-7"
		);
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
		const throwing: Storage = {
			clear: () => {
				throw new Error("no storage");
			},
			key: () => {
				throw new Error("no storage");
			},
			get length() {
				return 0;
			},
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

describe("microphone permission lifecycle", () => {
	const originalNavigator = Object.getOwnPropertyDescriptor(
		globalThis,
		"navigator"
	);
	afterEach(() => {
		if (originalNavigator) {
			Object.defineProperty(globalThis, "navigator", originalNavigator);
		} else {
			Reflect.deleteProperty(globalThis, "navigator");
		}
	});
	function installMedia(getUserMedia?: () => Promise<FixtureMicrophoneStream>) {
		Object.defineProperty(globalThis, "navigator", {
			configurable: true,
			value: { mediaDevices: getUserMedia ? { getUserMedia } : undefined },
		});
	}
	it("reports unavailable and denied access without throwing", async () => {
		installMedia();
		expect(await ensureMicPermission()).toBe(false);
		installMedia(() =>
			Promise.reject(new DOMException("denied", "NotAllowedError"))
		);
		expect(await ensureMicPermission()).toBe(false);
		installMedia(() => {
			throw new Error("device unavailable");
		});
		expect(await ensureMicPermission()).toBe(false);
	});
	it("shares an unanswered prompt and stops every track after a grant", async () => {
		let answer!: (stream: FixtureMicrophoneStream) => void;
		const request = mock(
			() =>
				new Promise<FixtureMicrophoneStream>((resolve) => {
					answer = resolve;
				})
		);
		installMedia(request);
		const first = ensureMicPermission();
		const second = ensureMicPermission();
		expect(first).toBe(second);
		await Promise.resolve();
		const stops = [mock(() => undefined), mock(() => undefined)];
		answer({
			getTracks: () => stops.map((stop) => ({ stop })),
		});
		expect(await first).toBe(true);
		expect(request).toHaveBeenCalledTimes(1);
		for (const stop of stops) {
			expect(stop).toHaveBeenCalledTimes(1);
		}
	});
	it("times out an ignored prompt and stops tracks when its grant arrives late", async () => {
		let answer!: (stream: FixtureMicrophoneStream) => void;
		installMedia(
			() =>
				new Promise<FixtureMicrophoneStream>((resolve) => {
					answer = resolve;
				})
		);
		const timers = spyOn(globalThis, "setTimeout");
		const request = ensureMicPermission();
		const index = timers.mock.calls.findIndex((call) => call[1] === 15_000);
		const callback = requireTestValue(
			timers.mock.calls[index],
			"microphone timeout callback"
		)[0];
		expect(isNativeFunction(callback)).toBe(true);
		if (isNativeFunction(callback)) {
			callback();
		}
		expect(await request).toBe(false);
		expect(ensureMicPermission()).toBe(request);
		const stop = mock(() => undefined);
		answer({ getTracks: () => [{ stop }] });
		await new Promise<void>((resolve) =>
			queueMicrotask(() => queueMicrotask(() => queueMicrotask(resolve)))
		);
		expect(stop).toHaveBeenCalledTimes(1);
		timers.mockRestore();
		installMedia(() => Promise.reject(new Error("denied")));
		expect(await ensureMicPermission()).toBe(false);
	});
});
