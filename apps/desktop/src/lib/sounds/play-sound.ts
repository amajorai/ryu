// Public UI sound API. Callers fire cues by id; the singleton engine applies
// the user's prefs, Do Not Disturb, window routing and throttling. Nothing
// here ever throws into a caller.

import { getUserAvailabilitySnapshot } from "../user-availability.ts";
import { isMainWindow } from "../window-routing.ts";
import type { SoundEventId } from "./sound-catalog.ts";
import { type PlaySoundOptions, UiSoundEngine } from "./sound-engine.ts";
import { readSoundPrefs, readSoundVolume } from "./sound-preferences.ts";
import {
	createSoundSync,
	openBrowserSoundChannel,
	type SoundSync,
	type SoundSyncMessage,
} from "./sound-sync.ts";
import type { SoundAudioContext } from "./sound-synth.ts";

export type { PlaySoundOptions } from "./sound-engine.ts";

export type SoundCallKind = "play" | "preview" | "loop";

/** A test double that records cues instead of playing them. */
export type SoundSink = (
	id: SoundEventId,
	options: PlaySoundOptions & { kind: SoundCallKind }
) => void;

let engine: UiSoundEngine | null = null;
let sync: SoundSync | null = null;
let sink: SoundSink | null = null;

type AudioContextConstructor = new (
	options?: AudioContextOptions
) => AudioContext;

function createBrowserContext(): SoundAudioContext | null {
	const scope = globalThis as {
		AudioContext?: AudioContextConstructor;
		webkitAudioContext?: AudioContextConstructor;
	};
	const Constructor = scope.AudioContext ?? scope.webkitAudioContext;
	if (!Constructor) {
		return null;
	}
	// Typed as the real AudioContext so the compiler proves it satisfies the
	// synth's structural slice.
	const context: SoundAudioContext = new Constructor({
		latencyHint: "interactive",
	});
	return context;
}

function readAvailability(): string {
	try {
		return getUserAvailabilitySnapshot().status;
	} catch {
		return "online";
	}
}

function applyRemote(target: UiSoundEngine, message: SoundSyncMessage): void {
	if (message.kind === "played") {
		target.rememberPlayedKey(message.key, message.at);
	} else if (message.kind === "stopped") {
		target.markRunStopped(message.conversationId, message.at);
	} else {
		target.markRunStarted(message.conversationId, message.at);
	}
}

function getEngine(): UiSoundEngine {
	if (!engine) {
		const created = new UiSoundEngine({
			createContext: createBrowserContext,
			getAvailability: readAvailability,
			getPrefs: readSoundPrefs,
			getVolume: readSoundVolume,
			isMainWindow,
			now: () => Date.now(),
		});
		engine = created;
		sync = createSoundSync(openBrowserSoundChannel(), (message) =>
			applyRemote(created, message)
		);
	}
	return engine;
}

/** Tell the other Ryu windows; a no-op before any engine exists. */
function broadcast(message: SoundSyncMessage): void {
	sync?.post(message);
}

/** Play a UI cue. Silent when sounds are off, muted or unsupported. */
export function playSound(
	id: SoundEventId,
	options: PlaySoundOptions = {}
): void {
	if (sink) {
		sink(id, { ...options, kind: "play" });
		return;
	}
	const played = getEngine().play(id, options);
	if (played && options.key) {
		broadcast({ kind: "played", key: options.key, at: Date.now() });
	}
}

/**
 * Settings preview: plays even when that cue's own switch is off (the master
 * switch and volume still apply).
 */
export function previewSound(id: SoundEventId): void {
	if (sink) {
		sink(id, { gesture: true, kind: "preview" });
		return;
	}
	getEngine().preview(id);
}

/** Loop a cue (the connecting ring). The returned stop is idempotent. */
export function startLoopingSound(id: SoundEventId): () => void {
	if (sink) {
		sink(id, { kind: "loop" });
		return () => undefined;
	}
	return getEngine().startLoop(id);
}

/** The user stopped this conversation's run; skip its completion cue. */
export function markRunStopped(
	conversationId: string | null | undefined
): void {
	if (!conversationId || sink) {
		return;
	}
	const at = Date.now();
	getEngine().markRunStopped(conversationId, at);
	broadcast({ kind: "stopped", conversationId, at });
}

/**
 * A new turn started in this conversation: the previous turn's Stop and
 * completion dedupe stop covering it after a short grace, in every window.
 */
export function markRunStarted(
	conversationId: string | null | undefined
): void {
	if (!conversationId || sink) {
		return;
	}
	const at = Date.now();
	getEngine().markRunStarted(conversationId, at);
	broadcast({ kind: "started", conversationId, at });
}

/**
 * A voice call went live (`true`) or ended (`false`): notification cues play
 * quieter while any call is live. Calls are counted, so balance every `true`
 * with exactly one `false`. Call state is not a cue, so it reaches the engine
 * even while a test sink is installed.
 */
export function setVoiceCallActive(active: boolean): void {
	getEngine().setVoiceCallActive(active);
}

/** Whether any voice call in this window is live (ducking is on). */
export function isVoiceCallActive(): boolean {
	return engine?.isVoiceCallActive() ?? false;
}

/**
 * Tests only: route every cue to `next` instead of the engine (it then sees
 * calls regardless of prefs), or restore the engine with `null`.
 */
export function __setSoundSinkForTests(next: SoundSink | null): void {
	sink = next;
}

/** Tests only: drop the singleton so the next cue builds a fresh engine. */
export function __resetSoundEngineForTests(): void {
	engine?.dispose();
	engine = null;
	sync?.dispose();
	sync = null;
}

// Build the engine as soon as any sound caller loads, so its input listener
// is armed before the first cue that has no gesture behind it.
if ("addEventListener" in globalThis) {
	getEngine();
}
