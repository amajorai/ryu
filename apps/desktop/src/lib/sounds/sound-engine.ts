// The UI sound engine: one lazily created AudioContext, a master gain, and the
// rules that keep cues pleasant in practice (no duplicates from two sources,
// no bursts, no mush of overlapping cues, quiet in Do Not Disturb, ducked
// during calls). Every dependency is injected so tests drive it with a fake
// context and a manual clock.

import { SOUND_EVENTS, type SoundEventId } from "./sound-catalog.ts";
import { RING_PERIOD_SEC, renderPattern, SOUND_PACKS } from "./sound-packs.ts";
import {
	clampSoundVolume,
	isSoundEventEnabled,
	type SoundPrefs,
} from "./sound-preferences.ts";
import {
	createLoop,
	DEFAULT_SOUND_TIMERS,
	type ScheduledSound,
	type SoundAudioContext,
	type SoundGain,
	type SoundTimers,
	scheduleTones,
} from "./sound-synth.ts";

/** The Do Not Disturb literal of `AgentAvailabilityStatus`. */
export const DND_STATUS = "do-not-disturb";

/** Same key within this window plays once (two sources, one event). */
export const SOUND_DEDUPE_MS = 3000;
/** A Stop silences the run's completion cue for this long. */
export const RUN_STOP_SUPPRESS_MS = 5000;
/**
 * Once the next turn in that conversation starts, the stopped (or finished)
 * turn's late settle is still covered for this long, and no longer, so the new
 * turn's own completion cue plays.
 */
export const RUN_NEXT_TURN_GRACE_MS = 1000;
export const MAX_SOUND_VOICES = 3;
/** A cue this soon after an equal-or-higher priority cue is dropped. */
export const SOUND_STACK_WINDOW_MS = 120;
/** Notification cues play at this fraction while a voice call is live. */
export const CALL_DUCK_FACTOR = 0.5;
/**
 * Overall output level at 100 % volume. Pattern gains peak around 0.6 and
 * dyads stack, so this keeps the loudest chord well clear of clipping.
 */
export const SOUND_OUTPUT_LEVEL = 0.4;

const MAX_TRACKED_KEYS = 64;
const START_DELAY_SEC = 0.005;
const CUT_FADE_SEC = 0.03;

export interface PlaySoundOptions {
	/** True when a user gesture triggered the cue (may unlock audio). */
	gesture?: boolean;
	/** Dedupe key: the same key plays once per SOUND_DEDUPE_MS. */
	key?: string;
	/** `stream`: a broadcast event every window receives; main window only. */
	source?: "stream" | "local";
}

export interface UiSoundEngineDeps {
	/** Install a one-time gesture listener; returns its remover. */
	addUnlockListener?: (unlock: () => void) => () => void;
	createContext: () => SoundAudioContext | null;
	getAvailability: () => string;
	getPrefs: () => SoundPrefs;
	getVolume: () => number;
	isMainWindow: () => boolean;
	/** Milliseconds, monotonic enough for throttling. */
	now: () => number;
	timers?: SoundTimers;
}

interface ActiveVoice {
	endsAtMs: number;
	id: SoundEventId;
	priority: number;
	scheduled: ScheduledSound;
	startedAtMs: number;
}

function defaultUnlockListener(unlock: () => void): () => void {
	if (!("addEventListener" in globalThis)) {
		return () => undefined;
	}
	const handler = () => {
		remove();
		unlock();
	};
	const remove = () => {
		globalThis.removeEventListener("pointerdown", handler, true);
		globalThis.removeEventListener("keydown", handler, true);
	};
	globalThis.addEventListener("pointerdown", handler, true);
	globalThis.addEventListener("keydown", handler, true);
	return remove;
}

function rememberKey(map: Map<string, number>, key: string, at: number): void {
	map.delete(key);
	map.set(key, at);
	while (map.size > MAX_TRACKED_KEYS) {
		const oldest = map.keys().next().value;
		if (oldest === undefined) {
			break;
		}
		map.delete(oldest);
	}
}

export class UiSoundEngine {
	private active: ActiveVoice[] = [];
	private context: SoundAudioContext | null = null;
	private contextFailed = false;
	private readonly deps: UiSoundEngineDeps;
	private readonly lastPlayedAt = new Map<SoundEventId, number>();
	private master: SoundGain | null = null;
	private readonly playedKeys = new Map<string, number>();
	private readonly stoppedRuns = new Map<string, number>();
	private removeUnlock: (() => void) | null = null;
	private voiceCalls = 0;

	constructor(deps: UiSoundEngineDeps) {
		this.deps = deps;
		// Listen from the start: the first input creates (or resumes) the
		// context, so the first cue with no gesture behind it (a run finishing,
		// a notification) finds audio already running instead of being dropped.
		this.armUnlock();
	}

	/** Play a cue if every rule allows it. Returns whether it was scheduled. */
	play(id: SoundEventId, options: PlaySoundOptions = {}): boolean {
		try {
			return this.playChecked(id, options, false);
		} catch {
			return false;
		}
	}

	/** Settings preview: ignores the cue's own switch, throttles and DND. */
	preview(id: SoundEventId): boolean {
		try {
			return this.playChecked(id, { gesture: true }, true);
		} catch {
			return false;
		}
	}

	/** Repeat a cue (the connecting ring) until the returned stop runs. */
	startLoop(id: SoundEventId): () => void {
		try {
			const prefs = this.deps.getPrefs();
			const volume = clampSoundVolume(this.deps.getVolume());
			if (!(prefs.enabled && volume > 0 && isSoundEventEnabled(prefs, id))) {
				return () => undefined;
			}
			const ctx = this.ensureContext();
			if (!(ctx && this.master)) {
				return () => undefined;
			}
			if (ctx.state !== "running") {
				this.resume(ctx);
				this.armUnlock();
			}
			const sound = renderPattern(SOUND_PACKS[prefs.pack], id);
			return createLoop(
				ctx,
				this.master,
				sound,
				volume * SOUND_OUTPUT_LEVEL,
				RING_PERIOD_SEC,
				this.deps.timers ?? DEFAULT_SOUND_TIMERS
			);
		} catch {
			return () => undefined;
		}
	}

	/** A user Stop: never celebrate (or mourn) that run from any source. */
	markRunStopped(conversationId: string, at = this.deps.now()): void {
		const until = at + RUN_STOP_SUPPRESS_MS;
		const key = `run:${conversationId}`;
		const existing = this.stoppedRuns.get(key);
		if (existing !== undefined && existing >= until) {
			return;
		}
		rememberKey(this.stoppedRuns, key, until);
	}

	/**
	 * A new turn started in this conversation. The previous turn's Stop
	 * suppression and completion dedupe end after a short grace (its own late
	 * settle is still covered), so this turn's completion cue is not swallowed.
	 */
	markRunStarted(conversationId: string, at = this.deps.now()): void {
		const key = `run:${conversationId}`;
		const graceEnd = at + RUN_NEXT_TURN_GRACE_MS;
		const stoppedUntil = this.stoppedRuns.get(key);
		if (stoppedUntil !== undefined && stoppedUntil > graceEnd) {
			this.stoppedRuns.set(key, graceEnd);
		}
		const playedAt = this.playedKeys.get(key);
		const latestPlayedAt = graceEnd - SOUND_DEDUPE_MS;
		if (playedAt !== undefined && playedAt > latestPlayedAt) {
			this.playedKeys.set(key, latestPlayedAt);
		}
	}

	/** Another window played this key; dedupe against it here too. */
	rememberPlayedKey(key: string, at: number): void {
		const existing = this.playedKeys.get(key);
		if (existing !== undefined && existing >= at) {
			return;
		}
		rememberKey(this.playedKeys, key, at);
	}

	/**
	 * Calls are reference-counted: every `true` must be balanced by one
	 * `false`, so one call ending never un-ducks another that is still live.
	 */
	setVoiceCallActive(active: boolean): void {
		this.voiceCalls = Math.max(0, this.voiceCalls + (active ? 1 : -1));
	}

	isVoiceCallActive(): boolean {
		return this.voiceCalls > 0;
	}

	dispose(): void {
		for (const voice of this.active) {
			voice.scheduled.cancel(CUT_FADE_SEC);
		}
		this.active = [];
		this.removeUnlock?.();
		this.removeUnlock = null;
	}

	private playChecked(
		id: SoundEventId,
		options: PlaySoundOptions,
		preview: boolean
	): boolean {
		const prefs = this.deps.getPrefs();
		const volume = clampSoundVolume(this.deps.getVolume());
		if (!prefs.enabled || volume <= 0) {
			return false;
		}
		if (!(preview || isSoundEventEnabled(prefs, id))) {
			return false;
		}
		if (options.source === "stream" && !this.deps.isMainWindow()) {
			return false;
		}
		const def = SOUND_EVENTS[id];
		const quietClass = def.class === "notification" || def.class === "reward";
		if (
			!preview &&
			quietClass &&
			prefs.quietInDnd &&
			this.deps.getAvailability() === DND_STATUS
		) {
			return false;
		}
		const now = this.deps.now();
		if (!(preview || this.passesThrottles(id, options.key, now))) {
			return false;
		}
		this.pruneVoices(now);
		if (!(preview || this.makeRoom(def.priority, now))) {
			return false;
		}
		const ctx = this.ensureContext();
		if (!(ctx && this.master)) {
			return false;
		}
		if (ctx.state !== "running") {
			this.resume(ctx);
			this.armUnlock();
			// A cue with no gesture behind it would burst out late once audio
			// unlocks; drop it instead of queueing.
			if (!options.gesture) {
				return false;
			}
		}
		if (preview) {
			this.cutVoices(() => true);
		}
		const duck =
			this.isVoiceCallActive() && def.class === "notification"
				? CALL_DUCK_FACTOR
				: 1;
		const sound = renderPattern(SOUND_PACKS[prefs.pack], id);
		const scheduled = scheduleTones(
			ctx,
			this.master,
			sound,
			volume * duck * SOUND_OUTPUT_LEVEL,
			ctx.currentTime + START_DELAY_SEC
		);
		const durationMs = (scheduled.endAt - scheduled.startAt) * 1000;
		this.active.push({
			id,
			priority: def.priority,
			scheduled,
			startedAtMs: now,
			endsAtMs: now + durationMs,
		});
		this.lastPlayedAt.set(id, now);
		if (options.key) {
			rememberKey(this.playedKeys, options.key, now);
		}
		return true;
	}

	private passesThrottles(
		id: SoundEventId,
		key: string | undefined,
		now: number
	): boolean {
		if (key) {
			const stoppedUntil = this.stoppedRuns.get(key);
			if (
				stoppedUntil !== undefined &&
				now < stoppedUntil &&
				(id === "run-complete" || id === "run-failed")
			) {
				return false;
			}
			const playedAt = this.playedKeys.get(key);
			if (playedAt !== undefined && now - playedAt < SOUND_DEDUPE_MS) {
				return false;
			}
		}
		const last = this.lastPlayedAt.get(id);
		const cooldown = SOUND_EVENTS[id].cooldownMs;
		return !(last !== undefined && cooldown > 0 && now - last < cooldown);
	}

	private pruneVoices(now: number): void {
		this.active = this.active.filter((voice) => voice.endsAtMs > now);
	}

	/** Apply the stacking rules; false when this cue should be dropped. */
	private makeRoom(priority: number, now: number): boolean {
		for (const voice of this.active) {
			if (
				now - voice.startedAtMs < SOUND_STACK_WINDOW_MS &&
				voice.priority >= priority
			) {
				return false;
			}
		}
		// A more important cue cuts the less important ones still ringing.
		this.cutVoices((voice) => voice.priority < priority);
		return this.active.length < MAX_SOUND_VOICES;
	}

	private cutVoices(shouldCut: (voice: ActiveVoice) => boolean): void {
		const kept: ActiveVoice[] = [];
		for (const voice of this.active) {
			if (shouldCut(voice)) {
				voice.scheduled.cancel(CUT_FADE_SEC);
			} else {
				kept.push(voice);
			}
		}
		this.active = kept;
	}

	private ensureContext(): SoundAudioContext | null {
		if (this.context) {
			return this.context;
		}
		if (this.contextFailed) {
			return null;
		}
		const ctx = this.deps.createContext();
		if (!ctx) {
			this.contextFailed = true;
			return null;
		}
		const master = ctx.createGain();
		master.gain.setValueAtTime(1, ctx.currentTime);
		master.connect(ctx.destination);
		this.context = ctx;
		this.master = master;
		return ctx;
	}

	/** Install the one-shot input listener unless one is already waiting. */
	private armUnlock(): void {
		if (this.removeUnlock) {
			return;
		}
		try {
			const install = this.deps.addUnlockListener ?? defaultUnlockListener;
			this.removeUnlock = install(() => {
				this.removeUnlock = null;
				this.unlock();
			});
		} catch {
			this.removeUnlock = null;
		}
	}

	/** A user gesture: create or resume the context while it is allowed to. */
	private unlock(): void {
		try {
			if (!this.deps.getPrefs().enabled) {
				// No context while sounds are off; wait for the next input.
				this.armUnlock();
				return;
			}
			const ctx = this.ensureContext();
			if (ctx && ctx.state !== "running") {
				this.resume(ctx);
			}
		} catch {
			// Never let a sound problem break an input event.
		}
	}

	private resume(ctx: SoundAudioContext): void {
		try {
			ctx.resume().catch(() => undefined);
		} catch {
			// Some hosts throw synchronously while the page unloads.
		}
	}
}
