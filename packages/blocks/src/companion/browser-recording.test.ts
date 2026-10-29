/** Complete local navigator fixture carrier for these stop-only lifecycle
 * probes. It is deliberately not claimed to be a native MediaStream or a full
 * MediaDevices implementation; the production native SDK owner is unchanged. */
interface FixtureMicrophoneStream {
	getTracks(): { stop(): void }[];
}

import { afterEach, expect, mock, test } from "bun:test";
import { BrowserRecordingHost } from "./browser-recording.ts";

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

test("missing media support cannot report a recording", async () => {
	installMedia();
	const result = await new BrowserRecordingHost().call("app", {
		action: "start",
	});
	expect(result.available).toBe(false);
	expect(result.state).toBe("idle");
});

test("permission denial propagates and releases the starting owner", async () => {
	const request = mock(() =>
		Promise.reject(new DOMException("denied", "NotAllowedError"))
	);
	installMedia(request);
	const host = new BrowserRecordingHost();
	await expect(host.call("app", { action: "start" })).rejects.toThrow("denied");
	await expect(host.call("app", { action: "start" })).rejects.toThrow("denied");
	expect(request).toHaveBeenCalledTimes(2);
	expect((await host.call("app", { action: "status" })).state).toBe("idle");
});

test("an unmounted app stops a late-granted microphone and cannot claim it", async () => {
	let answer!: (stream: FixtureMicrophoneStream) => void;
	installMedia(
		() =>
			new Promise<FixtureMicrophoneStream>((resolve) => {
				answer = resolve;
			})
	);
	const host = new BrowserRecordingHost();
	const pending = host.call("first", { action: "start" });
	await expect(host.call("second", { action: "start" })).rejects.toThrow(
		"Another app"
	);
	host.release("first");
	const stop = mock(() => undefined);
	answer({ getTracks: () => [{ stop }] });
	expect((await pending).state).toBe("idle");
	expect(stop).toHaveBeenCalledTimes(1);
	expect((await host.call("second", { action: "status" })).state).toBe("idle");
});

/** Minimal AudioContext stand-in: resume is controllable and close is counted. */
function installAudioContext(resume: () => Promise<void> = async () => {}) {
	const closed = mock(async () => undefined);
	const original = Object.getOwnPropertyDescriptor(globalThis, "AudioContext");
	class FixtureAudioContext {
		sampleRate = 16_000;
		destination = {};
		createMediaStreamSource() {
			return { connect: () => undefined };
		}
		createScriptProcessor() {
			return { connect: () => undefined, disconnect: () => undefined };
		}
		resume = resume;
		close = closed;
	}
	Object.defineProperty(globalThis, "AudioContext", {
		configurable: true,
		value: FixtureAudioContext,
	});
	return {
		closed,
		restore() {
			if (original) {
				Object.defineProperty(globalThis, "AudioContext", original);
			} else {
				Reflect.deleteProperty(globalThis, "AudioContext");
			}
		},
	};
}

function liveStream(stop: () => void) {
	const track = { readyState: "live", stop, onended: null };
	return { getTracks: () => [track], getAudioTracks: () => [track] };
}

test("back-to-back clips from one app reuse the open microphone", async () => {
	const stop = mock(() => undefined);
	const request = mock(() => Promise.resolve(liveStream(stop)));
	installMedia(request);
	const audio = installAudioContext();
	try {
		const host = new BrowserRecordingHost();
		for (let cycle = 0; cycle < 3; cycle++) {
			const started = await host.call("app", { action: "start" });
			expect(started.state).toBe("recording");
			const id = started.id ?? "";
			await host.call("app", { action: "stop", id });
			expect(
				(await host.call("app", { action: "read", id })).audio
			).toStartWith("data:audio/wav;base64,");
			await host.call("app", { action: "discard", id });
		}
		expect(request).toHaveBeenCalledTimes(1);
		expect(stop).not.toHaveBeenCalled();
		host.release("app");
		expect(stop).toHaveBeenCalledTimes(1);
	} finally {
		audio.restore();
	}
});

test("another app's start closes a warm microphone before opening its own", async () => {
	const firstStop = mock(() => undefined);
	const secondStop = mock(() => undefined);
	const streams = [liveStream(firstStop), liveStream(secondStop)];
	installMedia(() =>
		Promise.resolve(streams.shift() ?? liveStream(() => undefined))
	);
	const audio = installAudioContext();
	try {
		const host = new BrowserRecordingHost();
		const first = await host.call("first", { action: "start" });
		await host.call("first", { action: "stop", id: first.id ?? "" });
		const second = await host.call("second", { action: "start" });
		expect(second.state).toBe("recording");
		expect(firstStop).toHaveBeenCalledTimes(1);
		expect(secondStop).not.toHaveBeenCalled();
		expect((await host.call("first", { action: "status" })).state).toBe(
			"pending"
		);
	} finally {
		audio.restore();
	}
});

test("an app unmounted while the microphone resumes never claims it", async () => {
	let resumed!: () => void;
	const stop = mock(() => undefined);
	installMedia(() => Promise.resolve(liveStream(stop)));
	const audio = installAudioContext(
		() =>
			new Promise<void>((resolve) => {
				resumed = resolve;
			})
	);
	try {
		const host = new BrowserRecordingHost();
		const pending = host.call("app", { action: "start" });
		while (!resumed) {
			await Promise.resolve();
		}
		host.release("app");
		resumed();
		expect((await pending).state).toBe("idle");
		expect(stop).toHaveBeenCalledTimes(1);
		expect(audio.closed).toHaveBeenCalledTimes(1);
	} finally {
		audio.restore();
	}
});
