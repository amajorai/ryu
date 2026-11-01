import { describe, expect, it } from "bun:test";
import { FakeAudioContext, FakeClock } from "./sound-audio-context.fixture.ts";
import {
	CALL_DUCK_FACTOR,
	DND_STATUS,
	RUN_NEXT_TURN_GRACE_MS,
	SOUND_OUTPUT_LEVEL,
	UiSoundEngine,
} from "./sound-engine.ts";
import { DEFAULT_SOUND_PREFS, type SoundPrefs } from "./sound-preferences.ts";

interface Harness {
	availability: string;
	clock: FakeClock;
	ctx: FakeAudioContext;
	engine: UiSoundEngine;
	mainWindow: boolean;
	prefs: SoundPrefs;
	unlocks: Array<() => void>;
	volume: number;
}

function setup(
	options: { ctxState?: string; noContext?: boolean } = {}
): Harness & { contextsCreated: () => number } {
	let created = 0;
	const ctx = new FakeAudioContext(options.ctxState ?? "running");
	const clock = new FakeClock();
	clock.nowMs = 10_000;
	const harness = {
		availability: "online",
		clock,
		ctx,
		mainWindow: true,
		prefs: DEFAULT_SOUND_PREFS,
		unlocks: [] as Array<() => void>,
		volume: 1,
	} as Harness;
	harness.engine = new UiSoundEngine({
		createContext: () => {
			created += 1;
			return options.noContext ? null : ctx;
		},
		getAvailability: () => harness.availability,
		getPrefs: () => harness.prefs,
		getVolume: () => harness.volume,
		isMainWindow: () => harness.mainWindow,
		now: clock.now,
		timers: clock.timers,
		addUnlockListener: (unlock) => {
			harness.unlocks.push(unlock);
			return () => undefined;
		},
	});
	return Object.assign(harness, { contextsCreated: () => created });
}

const voices = (h: Harness) => h.ctx.voiceGains().length;
const firstPeak = (h: Harness) => h.ctx.voiceGains()[0]?.gain.peak() ?? 0;
/** Let any previous cue finish and clear the stacking window. */
const settle = (h: Harness) => h.clock.advance(2000);

describe("UiSoundEngine master rules", () => {
	it("plays a cue through a lazily created master gain", () => {
		const h = setup();
		expect(h.ctx.gains).toHaveLength(0);
		expect(h.engine.play("message")).toBe(true);
		const master = h.ctx.gains[0];
		expect(master?.connections).toEqual([h.ctx.destination]);
		expect(master?.gain.value).toBe(1);
		expect(h.ctx.oscillators.length).toBeGreaterThan(0);
	});

	it("is silent when disabled, the event is off, or the volume is 0", () => {
		const off = setup();
		off.prefs = { ...DEFAULT_SOUND_PREFS, enabled: false };
		expect(off.engine.play("message")).toBe(false);
		expect(off.engine.preview("message")).toBe(false);
		expect(off.ctx.oscillators).toHaveLength(0);

		const eventOff = setup();
		eventOff.prefs = { ...DEFAULT_SOUND_PREFS, events: { message: false } };
		expect(eventOff.engine.play("message")).toBe(false);
		expect(eventOff.engine.play("message-sent")).toBe(false);
		expect(eventOff.ctx.oscillators).toHaveLength(0);
		expect(eventOff.engine.preview("message")).toBe(true);

		const muted = setup();
		muted.volume = 0;
		expect(muted.engine.play("run-complete")).toBe(false);
		expect(muted.ctx.oscillators).toHaveLength(0);
	});

	it("is a no-op without Web Audio and never throws", () => {
		const h = setup({ noContext: true });
		expect(h.engine.play("message")).toBe(false);
		expect(h.engine.startLoop("call-ring")()).toBeUndefined();
		const throwing = new UiSoundEngine({
			createContext: () => {
				throw new Error("no audio");
			},
			getAvailability: () => "online",
			getPrefs: () => DEFAULT_SOUND_PREFS,
			getVolume: () => 1,
			isMainWindow: () => true,
			now: () => 0,
		});
		expect(throwing.play("message")).toBe(false);
		expect(throwing.preview("message")).toBe(false);
	});

	it("drops stream cues outside the main window but plays local ones", () => {
		const h = setup();
		h.mainWindow = false;
		expect(h.engine.play("message", { source: "stream" })).toBe(false);
		expect(h.engine.play("message", { source: "local" })).toBe(true);
	});

	it("quiets notification and reward cues in Do Not Disturb, not feedback or calls", () => {
		const h = setup();
		h.availability = DND_STATUS;
		expect(h.engine.play("message")).toBe(false);
		expect(h.engine.play("quest-complete")).toBe(false);
		expect(h.engine.play("mute")).toBe(true);
		settle(h);
		expect(h.engine.play("call-join")).toBe(true);
		settle(h);
		h.prefs = { ...DEFAULT_SOUND_PREFS, quietInDnd: false };
		expect(h.engine.play("message")).toBe(true);
	});
});

describe("UiSoundEngine throttling", () => {
	it("plays the same key once within 3 s and again after", () => {
		const h = setup();
		expect(h.engine.play("run-complete", { key: "run:a" })).toBe(true);
		h.clock.advance(1500);
		expect(h.engine.play("run-complete", { key: "run:a" })).toBe(false);
		expect(h.engine.play("run-complete", { key: "run:b" })).toBe(true);
		h.clock.advance(1600);
		expect(h.engine.play("run-complete", { key: "run:a" })).toBe(true);
	});

	it("suppresses a stopped run's completion and failure cues for 5 s", () => {
		const h = setup();
		h.engine.markRunStopped("conv-1");
		expect(h.engine.play("run-complete", { key: "run:conv-1" })).toBe(false);
		expect(h.engine.play("run-failed", { key: "run:conv-1" })).toBe(false);
		expect(h.engine.play("run-complete", { key: "run:conv-2" })).toBe(true);
		h.clock.advance(5100);
		expect(h.engine.play("run-complete", { key: "run:conv-1" })).toBe(true);
	});

	it("a new turn ends the Stop suppression after a short grace", () => {
		const h = setup();
		h.engine.markRunStopped("conv-1");
		// The stopped turn settles: silent.
		expect(h.engine.play("run-complete", { key: "run:conv-1" })).toBe(false);
		h.clock.advance(200);
		h.engine.markRunStarted("conv-1");
		// A late settle of the stopped turn inside the grace is still silent.
		h.clock.advance(RUN_NEXT_TURN_GRACE_MS - 100);
		expect(h.engine.play("run-failed", { key: "run:conv-1" })).toBe(false);
		// The new turn finishing well inside the old 5 s window plays.
		h.clock.advance(1500);
		expect(h.engine.play("run-complete", { key: "run:conv-1" })).toBe(true);
	});

	it("a new turn ends the previous turn's dedupe after the grace", () => {
		const h = setup();
		expect(h.engine.play("run-complete", { key: "run:c" })).toBe(true);
		h.clock.advance(100);
		h.engine.markRunStarted("c");
		h.clock.advance(RUN_NEXT_TURN_GRACE_MS + 100);
		// 1.2 s after the first cue, inside the 3 s dedupe, but a new turn.
		expect(h.engine.play("run-complete", { key: "run:c" })).toBe(true);
	});

	it("dedupes against a key another window played, and stops from it", () => {
		const h = setup();
		h.engine.rememberPlayedKey("run:remote", h.clock.nowMs - 500);
		expect(h.engine.play("run-complete", { key: "run:remote" })).toBe(false);
		h.engine.markRunStopped("elsewhere", h.clock.nowMs - 4000);
		expect(h.engine.play("run-failed", { key: "run:elsewhere" })).toBe(false);
		h.clock.advance(1100);
		expect(h.engine.play("run-failed", { key: "run:elsewhere" })).toBe(true);
	});

	it("applies per-event cooldowns", () => {
		const h = setup();
		expect(h.engine.play("message")).toBe(true);
		h.clock.advance(300);
		expect(h.engine.play("message")).toBe(false);
		h.clock.advance(400);
		expect(h.engine.play("message")).toBe(true);
		settle(h);
		expect(h.engine.play("mute")).toBe(true);
		h.clock.advance(130);
		expect(h.engine.play("unmute")).toBe(true);
		h.clock.advance(130);
		expect(h.engine.play("mute")).toBe(true);
	});
});

describe("UiSoundEngine stacking", () => {
	it("drops a cue right after an equal-or-higher priority one", () => {
		const h = setup();
		expect(h.engine.play("approval-needed")).toBe(true);
		h.clock.advance(50);
		expect(h.engine.play("message")).toBe(false);
		expect(h.engine.play("alert")).toBe(false);
	});

	it("lets a higher priority cue cut a lower one with a short fade", () => {
		const h = setup();
		expect(h.engine.play("quest-suggest")).toBe(true);
		const lowGain = h.ctx.voiceGains()[0];
		h.clock.advance(50);
		h.ctx.currentTime = 0.05;
		expect(h.engine.play("run-failed")).toBe(true);
		expect(lowGain?.gain.calls.at(-1)?.kind).toBe("target");
	});

	it("caps concurrent voices at 3", () => {
		const cap = setup();
		expect(cap.engine.play("achievement", { key: "1" })).toBe(true);
		cap.clock.advance(150);
		expect(cap.engine.play("run-failed")).toBe(true);
		cap.clock.advance(150);
		expect(cap.engine.play("credit-alert")).toBe(true);
		cap.clock.advance(150);
		expect(cap.engine.play("alert")).toBe(false);
		cap.clock.advance(1000);
		expect(cap.engine.play("alert")).toBe(true);
	});
});

describe("UiSoundEngine loudness", () => {
	it("scales peak gain linearly with volume", () => {
		const loud = setup();
		loud.engine.play("quest-suggest");
		const quiet = setup();
		quiet.volume = 0.25;
		quiet.engine.play("quest-suggest");
		expect(firstPeak(loud)).toBeCloseTo(0.35 * SOUND_OUTPUT_LEVEL, 6);
		expect(firstPeak(quiet)).toBeCloseTo(firstPeak(loud) * 0.25, 6);
	});

	it("halves notification cues during a call but not call cues", () => {
		const h = setup();
		h.engine.play("quest-suggest");
		const normal = firstPeak(h);
		const ducked = setup();
		ducked.engine.setVoiceCallActive(true);
		expect(ducked.engine.isVoiceCallActive()).toBe(true);
		ducked.engine.play("quest-suggest");
		expect(firstPeak(ducked)).toBeCloseTo(normal * CALL_DUCK_FACTOR, 6);
		const call = setup();
		call.engine.setVoiceCallActive(true);
		call.engine.play("call-join");
		const plain = setup();
		plain.engine.play("call-join");
		expect(firstPeak(call)).toBeCloseTo(firstPeak(plain), 6);
	});

	it("counts live calls, so one call ending keeps another ducked", () => {
		const h = setup();
		h.engine.setVoiceCallActive(true);
		h.engine.setVoiceCallActive(true);
		h.engine.setVoiceCallActive(false);
		expect(h.engine.isVoiceCallActive()).toBe(true);
		h.engine.setVoiceCallActive(false);
		expect(h.engine.isVoiceCallActive()).toBe(false);
		// An unbalanced end never goes negative and blocks the next call.
		h.engine.setVoiceCallActive(false);
		h.engine.setVoiceCallActive(true);
		expect(h.engine.isVoiceCallActive()).toBe(true);
	});

	it("renders the chosen pack", () => {
		const h = setup();
		h.prefs = { ...DEFAULT_SOUND_PREFS, pack: "retro" };
		h.engine.play("message");
		expect(h.ctx.oscillators.every((osc) => osc.type === "square")).toBe(true);
		expect(h.ctx.filters).toHaveLength(1);
	});
});

describe("UiSoundEngine unlock and previews", () => {
	it("drops a cue on a suspended context without a gesture, and unlocks on input", () => {
		const h = setup({ ctxState: "suspended" });
		expect(h.engine.play("message")).toBe(false);
		expect(voices(h)).toBe(0);
		expect(h.ctx.resumeCalls).toBe(1);
		expect(h.unlocks).toHaveLength(1);
		h.unlocks[0]?.();
		expect(h.ctx.resumeCalls).toBe(2);
		h.ctx.state = "running";
		h.clock.advance(5000);
		expect(voices(h)).toBe(0);
		expect(h.engine.play("message")).toBe(true);
	});

	it("arms the unlock at construction so the first background cue plays", () => {
		const h = setup({ ctxState: "suspended" });
		expect(h.unlocks).toHaveLength(1);
		expect(h.contextsCreated()).toBe(0);
		// Any click or key press creates and resumes the context ahead of time.
		h.unlocks[0]?.();
		expect(h.contextsCreated()).toBe(1);
		expect(h.ctx.resumeCalls).toBe(1);
		h.ctx.state = "running";
		expect(h.engine.play("run-complete", { key: "run:first" })).toBe(true);
		expect(voices(h)).toBeGreaterThan(0);
	});

	it("does not build a context on input while sounds are off", () => {
		const h = setup({ ctxState: "suspended" });
		h.prefs = { ...DEFAULT_SOUND_PREFS, enabled: false };
		h.unlocks[0]?.();
		expect(h.contextsCreated()).toBe(0);
		// Re-armed for the next input once sounds are back on.
		expect(h.unlocks).toHaveLength(2);
		h.prefs = DEFAULT_SOUND_PREFS;
		h.unlocks[1]?.();
		expect(h.contextsCreated()).toBe(1);
	});

	it("re-arms the unlock when a running context is suspended again", () => {
		const h = setup();
		h.unlocks[0]?.();
		h.ctx.state = "interrupted";
		expect(h.engine.play("message")).toBe(false);
		expect(h.unlocks).toHaveLength(2);
	});

	it("schedules a gesture cue while resuming", () => {
		const h = setup({ ctxState: "suspended" });
		expect(h.engine.play("mute", { gesture: true })).toBe(true);
		expect(voices(h)).toBeGreaterThan(0);
	});

	it("previews bypass throttles and cut whatever is playing", () => {
		const h = setup();
		h.engine.play("achievement");
		const earlier = h.ctx.voiceGains()[0];
		h.ctx.currentTime = 0.02;
		expect(h.engine.preview("quest-suggest")).toBe(true);
		expect(h.engine.preview("quest-suggest")).toBe(true);
		expect(earlier?.gain.calls.at(-1)?.kind).toBe("target");
		h.availability = DND_STATUS;
		expect(h.engine.preview("message")).toBe(true);
	});
});

describe("UiSoundEngine loops", () => {
	it("rings until stopped and respects the Calling switch", () => {
		const h = setup();
		const stop = h.engine.startLoop("call-ring");
		const first = h.ctx.oscillators.length;
		expect(first).toBeGreaterThan(0);
		h.ctx.currentTime = 2.2;
		h.clock.advance(2200);
		expect(h.ctx.oscillators.length).toBe(first * 2);
		stop();
		h.clock.advance(10_000);
		expect(h.ctx.oscillators.length).toBe(first * 2);

		const off = setup();
		off.prefs = { ...DEFAULT_SOUND_PREFS, events: { calling: false } };
		off.engine.startLoop("call-ring")();
		expect(off.ctx.oscillators).toHaveLength(0);
	});

	it("dispose fades out active cues", () => {
		const h = setup();
		h.engine.play("achievement");
		h.ctx.currentTime = 0.02;
		h.engine.dispose();
		expect(h.ctx.voiceGains()[0]?.gain.calls.at(-1)?.kind).toBe("target");
	});
});
