// A recording fake of the Web Audio slice the UI sound synth uses. Tests read
// back the oscillators, gain envelopes and filters a cue scheduled instead of
// listening to it.

import type {
	SoundAudioContext,
	SoundAudioNode,
	SoundAudioParam,
	SoundFilter,
	SoundGain,
	SoundOscillator,
} from "./sound-synth.ts";

export type ParamCall =
	| { kind: "set"; time: number; value: number }
	| { kind: "linear"; time: number; value: number }
	| { kind: "exp"; time: number; value: number }
	| { constant: number; kind: "target"; time: number; value: number }
	| { kind: "cancel"; time: number }
	| { kind: "hold"; time: number };

export class FakeParam implements SoundAudioParam {
	readonly calls: ParamCall[] = [];
	value: number;

	constructor(value = 0) {
		this.value = value;
	}

	setValueAtTime(value: number, time: number) {
		this.calls.push({ kind: "set", value, time });
		this.value = value;
	}

	linearRampToValueAtTime(value: number, time: number) {
		this.calls.push({ kind: "linear", value, time });
	}

	exponentialRampToValueAtTime(value: number, time: number) {
		this.calls.push({ kind: "exp", value, time });
	}

	setTargetAtTime(value: number, time: number, constant: number) {
		this.calls.push({ kind: "target", value, time, constant });
	}

	cancelScheduledValues(time: number) {
		this.calls.push({ kind: "cancel", time });
	}

	/** Highest value any automation call targets. */
	peak(): number {
		let peak = 0;
		for (const call of this.calls) {
			if ("value" in call) {
				peak = Math.max(peak, call.value);
			}
		}
		return peak;
	}
}

export class FakeNode implements SoundAudioNode {
	readonly connections: SoundAudioNode[] = [];
	disconnected = false;

	connect(destination: SoundAudioNode) {
		this.connections.push(destination);
		return destination;
	}

	disconnect() {
		this.disconnected = true;
	}
}

export class FakeOscillator extends FakeNode implements SoundOscillator {
	readonly detune = new FakeParam(0);
	readonly frequency = new FakeParam(440);
	onended: ((event: Event) => void) | null = null;
	startedAt: number | null = null;
	stops: number[] = [];
	type: OscillatorType = "sine";

	start(when = 0) {
		this.startedAt = when;
	}

	stop(when = 0) {
		this.stops.push(when);
	}

	/** Simulate the browser firing `ended`. */
	end() {
		this.onended?.(new Event("ended"));
	}
}

export class FakeGain extends FakeNode implements SoundGain {
	readonly gain = new FakeParam(1);
}

export class FakeFilter extends FakeNode implements SoundFilter {
	readonly frequency = new FakeParam(350);
	readonly Q = new FakeParam(1);
	type: BiquadFilterType = "lowpass";
}

export class FakeAudioContext implements SoundAudioContext {
	currentTime = 0;
	readonly destination = new FakeNode();
	readonly filters: FakeFilter[] = [];
	readonly gains: FakeGain[] = [];
	readonly oscillators: FakeOscillator[] = [];
	resumeCalls = 0;
	state: string;

	constructor(state = "running") {
		this.state = state;
	}

	createOscillator(): FakeOscillator {
		const oscillator = new FakeOscillator();
		this.oscillators.push(oscillator);
		return oscillator;
	}

	createGain(): FakeGain {
		const gain = new FakeGain();
		this.gains.push(gain);
		return gain;
	}

	createBiquadFilter(): FakeFilter {
		const filter = new FakeFilter();
		this.filters.push(filter);
		return filter;
	}

	resume(): Promise<void> {
		this.resumeCalls += 1;
		return Promise.resolve();
	}

	/** Gain nodes that envelope a tone (not the engine's master gain). */
	voiceGains(): FakeGain[] {
		return this.gains.filter((gain) =>
			gain.gain.calls.some((call) => call.kind === "linear")
		);
	}
}

/** A manual clock and timer queue for engine and loop tests. */
export class FakeClock {
	nowMs = 0;
	private nextHandle = 1;
	readonly pending = new Map<number, { at: number; callback: () => void }>();

	readonly timers = {
		setTimeout: (callback: () => void, ms: number): unknown => {
			const handle = this.nextHandle++;
			this.pending.set(handle, { at: this.nowMs + ms, callback });
			return handle;
		},
		clearTimeout: (handle: unknown) => {
			if (typeof handle === "number") {
				this.pending.delete(handle);
			}
		},
	};

	now = (): number => this.nowMs;

	/** Advance time, running every timer that falls due. */
	advance(ms: number): void {
		const target = this.nowMs + ms;
		for (;;) {
			let dueHandle: number | null = null;
			let dueAt = Number.POSITIVE_INFINITY;
			for (const [handle, entry] of this.pending) {
				if (entry.at <= target && entry.at < dueAt) {
					dueAt = entry.at;
					dueHandle = handle;
				}
			}
			if (dueHandle === null) {
				break;
			}
			const entry = this.pending.get(dueHandle);
			this.pending.delete(dueHandle);
			this.nowMs = dueAt;
			entry?.callback();
		}
		this.nowMs = target;
	}
}
