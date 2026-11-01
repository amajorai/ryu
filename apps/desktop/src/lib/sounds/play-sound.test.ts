import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}

const { FakeAudioContext } = await import("./sound-audio-context.fixture.ts");
const { parseSoundSyncMessage } = await import("./sound-sync.ts");
const {
	__resetSoundEngineForTests,
	__setSoundSinkForTests,
	isVoiceCallActive,
	markRunStarted,
	markRunStopped,
	playSound,
	previewSound,
	setVoiceCallActive,
	startLoopingSound,
} = await import("./play-sound.ts");
const { setSoundPrefs, setSoundVolume } = await import(
	"./sound-preferences.ts"
);
const { setUserAvailabilityStatus, resetUserAvailability } = await import(
	"../user-availability.ts"
);

const contexts: InstanceType<typeof FakeAudioContext>[] = [];
class GlobalFakeAudioContext extends FakeAudioContext {
	constructor() {
		super("running");
		contexts.push(this);
	}
}

const original = Object.getOwnPropertyDescriptor(globalThis, "AudioContext");
const oscillatorCount = () =>
	contexts.reduce((total, ctx) => total + ctx.oscillators.length, 0);

beforeEach(() => {
	localStorage.clear();
	contexts.length = 0;
	__setSoundSinkForTests(null);
	__resetSoundEngineForTests();
	resetUserAvailability();
	Object.defineProperty(globalThis, "AudioContext", {
		configurable: true,
		value: GlobalFakeAudioContext,
	});
});

afterEach(() => {
	__resetSoundEngineForTests();
	if (original) {
		Object.defineProperty(globalThis, "AudioContext", original);
	} else {
		Reflect.deleteProperty(globalThis, "AudioContext");
	}
});

describe("playSound", () => {
	it("plays through one shared AudioContext", () => {
		playSound("run-complete", { key: "run:a" });
		playSound("quest-suggest");
		expect(contexts).toHaveLength(1);
		expect(oscillatorCount()).toBeGreaterThan(0);
	});

	it("follows the stored prefs and volume", () => {
		setSoundPrefs({ enabled: false });
		playSound("message");
		previewSound("message");
		expect(oscillatorCount()).toBe(0);
		setSoundPrefs({ enabled: true });
		setSoundVolume(0);
		playSound("message");
		expect(oscillatorCount()).toBe(0);
	});

	it("is silent and safe where Web Audio is missing", () => {
		Reflect.deleteProperty(globalThis, "AudioContext");
		expect(() => playSound("message")).not.toThrow();
		expect(startLoopingSound("call-ring")()).toBeUndefined();
	});

	it("quiets notifications in Do Not Disturb from the availability store", () => {
		setUserAvailabilityStatus("do-not-disturb");
		playSound("message");
		expect(oscillatorCount()).toBe(0);
		playSound("mute", { gesture: true });
		expect(oscillatorCount()).toBeGreaterThan(0);
	});

	it("skips a stopped run's completion cue", () => {
		markRunStopped("conv-9");
		markRunStopped(null);
		playSound("run-complete", { key: "run:conv-9" });
		expect(oscillatorCount()).toBe(0);
	});

	it("previews a cue whose switch is off", () => {
		setSoundPrefs({ events: { "run-complete": false } });
		playSound("run-complete");
		expect(oscillatorCount()).toBe(0);
		previewSound("run-complete");
		expect(oscillatorCount()).toBeGreaterThan(0);
	});

	it("ducks notifications while a call is active", () => {
		playSound("quest-suggest");
		const normal = contexts[0]?.voiceGains()[0]?.gain.peak() ?? 0;
		__resetSoundEngineForTests();
		setVoiceCallActive(true);
		playSound("quest-suggest");
		const ducked = contexts[1]?.voiceGains()[0]?.gain.peak() ?? 0;
		expect(ducked).toBeCloseTo(normal / 2, 6);
	});

	it("loops the ring and stops it", () => {
		const stop = startLoopingSound("call-ring");
		const scheduled = oscillatorCount();
		expect(scheduled).toBeGreaterThan(0);
		// Stop once the first ring is sounding: sounding tones fade out, tones
		// not started yet are dropped at silence.
		const ctx = contexts[0];
		if (ctx) {
			ctx.currentTime = 0.1;
		}
		stop();
		stop();
		const gains = contexts[0]?.voiceGains() ?? [];
		expect(gains.length).toBeGreaterThan(0);
		const cut = (call: (typeof gains)[number]["gain"]["calls"][number]) =>
			call.kind === "target" || (call.kind === "set" && call.value === 0);
		expect(
			gains.every((gain) => {
				const last = gain.gain.calls.at(-1);
				return last !== undefined && cut(last);
			})
		).toBe(true);
		expect(
			gains.some((gain) => gain.gain.calls.at(-1)?.kind === "target")
		).toBe(true);
	});
});

describe("cross-window sound sync", () => {
	const otherWindows: BroadcastChannel[] = [];
	const openOtherWindow = (): {
		channel: BroadcastChannel;
		received: unknown[];
	} => {
		const channel = new BroadcastChannel("ryu:ui-sounds");
		otherWindows.push(channel);
		const received: unknown[] = [];
		channel.addEventListener("message", (event) => {
			received.push(event.data);
		});
		return { channel, received };
	};
	const delivery = () => new Promise((resolve) => setTimeout(resolve, 20));

	afterEach(() => {
		for (const channel of otherWindows.splice(0)) {
			channel.close();
		}
	});

	it("tells other windows what played, what stopped and what started", async () => {
		const other = openOtherWindow();
		playSound("run-complete", { key: "run:shared" });
		markRunStopped("conv-x");
		markRunStarted("conv-x");
		await delivery();
		expect(
			other.received.map((message) => parseSoundSyncMessage(message)?.kind)
		).toEqual(["played", "stopped", "started"]);
		expect(other.received[0]).toMatchObject({ key: "run:shared" });
		expect(other.received[1]).toMatchObject({ conversationId: "conv-x" });
	});

	it("skips a run another window already played or stopped", async () => {
		playSound("message");
		const before = oscillatorCount();
		const other = openOtherWindow();
		other.channel.postMessage({
			kind: "played",
			key: "run:tear-off",
			at: Date.now(),
		});
		other.channel.postMessage({
			kind: "stopped",
			conversationId: "stopped-in-tear-off",
			at: Date.now(),
		});
		await delivery();
		playSound("run-complete", { key: "run:tear-off", source: "stream" });
		playSound("run-failed", {
			key: "run:stopped-in-tear-off",
			source: "stream",
		});
		expect(oscillatorCount()).toBe(before);
	});
});

describe("setVoiceCallActive", () => {
	it("keeps ducking while another call is still live", () => {
		setVoiceCallActive(true);
		setVoiceCallActive(true);
		setVoiceCallActive(false);
		expect(isVoiceCallActive()).toBe(true);
		setVoiceCallActive(false);
		expect(isVoiceCallActive()).toBe(false);
	});
});

describe("__setSoundSinkForTests", () => {
	it("records every call instead of playing it", () => {
		const recorded: string[] = [];
		__setSoundSinkForTests((id, options) => {
			recorded.push(`${options.kind}:${id}:${options.key ?? ""}`);
		});
		playSound("approval-needed", { key: "approval:1", source: "stream" });
		previewSound("message");
		startLoopingSound("call-ring")();
		markRunStopped("x");
		setVoiceCallActive(true);
		expect(recorded).toEqual([
			"play:approval-needed:approval:1",
			"preview:message:",
			"loop:call-ring:",
		]);
		expect(contexts).toHaveLength(0);
		__setSoundSinkForTests(null);
		playSound("message");
		expect(contexts).toHaveLength(1);
	});
});
