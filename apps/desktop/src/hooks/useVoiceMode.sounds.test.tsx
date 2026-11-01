// Voice-mode call cues: the Ryu ring while connecting, join on ready, leave
// once per connected call (hang-up or remote end), a failure cue for a call
// that never connected, and exactly one mute/unmute cue per toggle even under
// StrictMode's doubled updaters.

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

interface FakeHandlers {
	onClose?: () => void;
	onError?: (code: string, message: string) => void;
	onReady?: () => void;
}

interface FakeOptions {
	handlers?: FakeHandlers;
	ringback?: (() => () => void) | false;
}

class FakeVoiceSession {
	static instances: FakeVoiceSession[] = [];
	readonly options: FakeOptions;
	closeCalls = 0;
	mutedCalls: boolean[] = [];
	stopRing: (() => void) | null = null;
	rejectStart: (error: Error) => void = () => undefined;

	constructor(_target: unknown, options: FakeOptions) {
		this.options = options;
		FakeVoiceSession.instances.push(this);
	}

	start(): Promise<void> {
		const ring = this.options.ringback;
		this.stopRing = typeof ring === "function" ? ring() : null;
		return new Promise((_resolve, reject) => {
			this.rejectStart = reject;
		});
	}

	close(): void {
		this.closeCalls += 1;
	}

	setMuted(muted: boolean): void {
		this.mutedCalls.push(muted);
	}

	abort(): void {
		// Barge-in is not exercised here.
	}

	/** Server-side events, delivered the way the real connection would. */
	ready(): void {
		this.stopRing?.();
		act(() => this.options.handlers?.onReady?.());
	}

	remoteClose(): void {
		act(() => this.options.handlers?.onClose?.());
	}

	serverError(): void {
		act(() => this.options.handlers?.onError?.("busy", "Voice is busy"));
	}
}

mock.module("@ryuhq/core-client/voice-session.ts", () => ({
	VoiceSessionConnection: FakeVoiceSession,
}));

const {
	__resetSoundEngineForTests,
	__setSoundSinkForTests,
	isVoiceCallActive,
} = await import("@/src/lib/sounds/play-sound.ts");
const { useVoiceMode } = await import("./useVoiceMode.ts");
type VoiceMode = ReturnType<typeof useVoiceMode>;

const cues: string[] = [];
let voice: VoiceMode | null = null;
let root: Root | null = null;

const target = { token: null, url: "https://node.example" };

function Harness() {
	voice = useVoiceMode(target);
	return null;
}

function current(): VoiceMode {
	if (!voice) {
		throw new Error("Harness not rendered");
	}
	return voice;
}

function latestSession(): FakeVoiceSession {
	const session = FakeVoiceSession.instances.at(-1);
	if (!session) {
		throw new Error("No voice session was opened");
	}
	return session;
}

function mount(strict: boolean) {
	act(() => root?.unmount());
	const container = document.createElement("div");
	root = createRoot(container);
	act(() => {
		root?.render(
			strict ? (
				<StrictMode>
					<Harness />
				</StrictMode>
			) : (
				<Harness />
			)
		);
	});
}

function startCall(): FakeVoiceSession {
	act(() => current().start());
	return latestSession();
}

beforeEach(() => {
	cues.length = 0;
	FakeVoiceSession.instances = [];
	__setSoundSinkForTests((id, options) => {
		cues.push(options.kind === "play" ? id : `${options.kind}:${id}`);
	});
	mount(false);
});

afterAll(() => {
	act(() => root?.unmount());
	__setSoundSinkForTests(null);
});

describe("useVoiceMode call cues", () => {
	test("connecting loops the Ryu ring and ready plays the join cue", () => {
		const session = startCall();
		expect(cues).toEqual(["loop:call-ring"]);
		session.ready();
		expect(cues).toEqual(["loop:call-ring", "call-join"]);
	});

	test("hanging up a connected call plays leave once, even if close follows", () => {
		const session = startCall();
		session.ready();
		cues.length = 0;
		act(() => current().stop());
		session.remoteClose();
		act(() => current().stop());
		expect(cues).toEqual(["call-leave"]);
		expect(session.closeCalls).toBe(1);
	});

	test("hanging up before the call connects stays silent", () => {
		const session = startCall();
		cues.length = 0;
		act(() => current().stop());
		session.remoteClose();
		expect(cues).toEqual([]);
	});

	test("a remote end after ready plays leave once and resets the call", () => {
		const session = startCall();
		session.ready();
		cues.length = 0;
		session.remoteClose();
		session.remoteClose();
		expect(cues).toEqual(["call-leave"]);
		expect(current().active).toBe(false);
	});

	test("a failed connect plays one error cue across error, close and rejection", async () => {
		const session = startCall();
		cues.length = 0;
		session.serverError();
		session.remoteClose();
		expect(cues).toEqual(["call-error"]);

		const retry = startCall();
		cues.length = 0;
		await act(async () => {
			retry.rejectStart(new Error("Microphone denied"));
			await Promise.resolve();
		});
		expect(cues).toEqual(["call-error"]);
		expect(current().error).toBe("Microphone denied");
	});

	test("an error after the call connected is not a connect failure", () => {
		const session = startCall();
		session.ready();
		cues.length = 0;
		session.serverError();
		expect(cues).toEqual([]);
	});
});

describe("useVoiceMode mute cues", () => {
	test("each toggle plays exactly one cue under StrictMode", () => {
		mount(true);
		const session = startCall();
		session.ready();
		cues.length = 0;
		act(() => current().toggleMute());
		expect(current().muted).toBe(true);
		act(() => current().toggleMute());
		expect(current().muted).toBe(false);
		expect(cues).toEqual(["mute", "unmute"]);
		expect(session.mutedCalls).toEqual([true, false]);
	});

	test("a new call starts unmuted, so the first toggle mutes", () => {
		const first = startCall();
		first.ready();
		act(() => current().toggleMute());
		act(() => current().stop());
		const second = startCall();
		second.ready();
		cues.length = 0;
		act(() => current().toggleMute());
		expect(cues).toEqual(["mute"]);
		expect(second.mutedCalls).toEqual([true]);
	});
});

describe("useVoiceMode call ducking", () => {
	let callVoice: VoiceMode | null = null;
	let otherRoot: Root | null = null;

	function CallTab() {
		callVoice = useVoiceMode(target);
		return null;
	}

	function OtherTab() {
		useVoiceMode(target);
		return null;
	}

	test("another instance unmounting keeps a live call ducked", () => {
		act(() => root?.unmount());
		__resetSoundEngineForTests();
		const callContainer = document.createElement("div");
		root = createRoot(callContainer);
		act(() => root?.render(<CallTab />));
		const otherContainer = document.createElement("div");
		otherRoot = createRoot(otherContainer);
		act(() => otherRoot?.render(<OtherTab />));

		act(() => callVoice?.start());
		latestSession().ready();
		expect(isVoiceCallActive()).toBe(true);

		// Closing another chat tab (its own idle voice mode) must not un-duck.
		act(() => otherRoot?.unmount());
		otherRoot = null;
		expect(isVoiceCallActive()).toBe(true);

		act(() => callVoice?.stop());
		expect(isVoiceCallActive()).toBe(false);
	});

	test("unmounting the instance with the live call releases ducking once", () => {
		act(() => root?.unmount());
		__resetSoundEngineForTests();
		root = createRoot(document.createElement("div"));
		act(() => root?.render(<CallTab />));
		act(() => callVoice?.start());
		latestSession().ready();
		expect(isVoiceCallActive()).toBe(true);
		act(() => root?.unmount());
		root = null;
		expect(isVoiceCallActive()).toBe(false);
	});
});
