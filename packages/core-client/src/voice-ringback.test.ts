import { afterEach, expect, test } from "bun:test";
import { startVoiceRingback } from "./voice-ringback.ts";

const original = Object.getOwnPropertyDescriptor(globalThis, "AudioContext");
afterEach(() => {
	if (original) {
		Object.defineProperty(globalThis, "AudioContext", original);
	} else {
		Reflect.deleteProperty(globalThis, "AudioContext");
	}
});

interface Recorder {
	closes: number;
	loop: boolean;
	starts: number;
	stops: number;
}

function installFakeAudio(): Recorder {
	const recorder: Recorder = { closes: 0, loop: false, starts: 0, stops: 0 };
	class FakeAudioContext {
		readonly destination = {};
		readonly sampleRate = 8000;
		createBuffer(_channels: number, length: number) {
			const samples = new Float32Array(length);
			return { getChannelData: () => samples };
		}
		createBufferSource() {
			return {
				buffer: null,
				connect: () => undefined,
				disconnect: () => undefined,
				set loop(value: boolean) {
					recorder.loop = value;
				},
				start: () => {
					recorder.starts += 1;
				},
				stop: () => {
					recorder.stops += 1;
				},
			};
		}
		close() {
			recorder.closes += 1;
			return Promise.resolve();
		}
		resume() {
			return Promise.resolve();
		}
	}
	Object.defineProperty(globalThis, "AudioContext", {
		configurable: true,
		value: FakeAudioContext,
	});
	return recorder;
}

test("without Web Audio the ringback is a silent no-op", () => {
	Reflect.deleteProperty(globalThis, "AudioContext");
	const stop = startVoiceRingback();
	expect(stop()).toBeUndefined();
});

test("the ringback loops until stopped and stopping twice releases once", () => {
	const recorder = installFakeAudio();
	const stop = startVoiceRingback();
	expect(recorder.loop).toBe(true);
	expect(recorder.starts).toBe(1);
	stop();
	stop();
	expect(recorder.stops).toBe(1);
	expect(recorder.closes).toBe(1);
});
