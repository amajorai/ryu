import { describe, expect, it } from "bun:test";
import {
	createSoundSync,
	parseSoundSyncMessage,
	type SoundSyncChannel,
	type SoundSyncMessage,
} from "./sound-sync.ts";

type Listener = (event: { data: unknown }) => void;

/** A pair of in-memory channels that deliver to each other, like two windows. */
function channelPair(): [FakeChannel, FakeChannel] {
	const a = new FakeChannel();
	const b = new FakeChannel();
	a.peer = b;
	b.peer = a;
	return [a, b];
}

class FakeChannel implements SoundSyncChannel {
	closed = false;
	readonly listeners = new Set<Listener>();
	peer: FakeChannel | null = null;
	throwOnPost = false;

	addEventListener(_type: "message", listener: Listener) {
		this.listeners.add(listener);
	}

	removeEventListener(_type: "message", listener: Listener) {
		this.listeners.delete(listener);
	}

	postMessage(message: unknown) {
		if (this.throwOnPost) {
			throw new Error("closing");
		}
		for (const listener of this.peer?.listeners ?? []) {
			listener({ data: structuredClone(message) });
		}
	}

	close() {
		this.closed = true;
	}
}

describe("parseSoundSyncMessage", () => {
	it("accepts the three message kinds", () => {
		expect(
			parseSoundSyncMessage({ kind: "played", key: "run:a", at: 5 })
		).toEqual({ kind: "played", key: "run:a", at: 5 });
		expect(
			parseSoundSyncMessage({ kind: "stopped", conversationId: "c", at: 1 })
		).toEqual({ kind: "stopped", conversationId: "c", at: 1 });
		expect(
			parseSoundSyncMessage({ kind: "started", conversationId: "c", at: 2 })
		).toEqual({ kind: "started", conversationId: "c", at: 2 });
	});

	it("rejects unknown kinds, empty ids and non-numeric times", () => {
		expect(parseSoundSyncMessage(null)).toBeNull();
		expect(parseSoundSyncMessage("played")).toBeNull();
		expect(
			parseSoundSyncMessage({ kind: "evict", key: "x", at: 1 })
		).toBeNull();
		expect(
			parseSoundSyncMessage({ kind: "played", key: "", at: 1 })
		).toBeNull();
		expect(
			parseSoundSyncMessage({ kind: "stopped", conversationId: "c", at: "1" })
		).toBeNull();
	});
});

describe("createSoundSync", () => {
	it("delivers a post from one window to the other, not back to itself", () => {
		const [mainChannel, tearOffChannel] = channelPair();
		const mainReceived: SoundSyncMessage[] = [];
		const tearOffReceived: SoundSyncMessage[] = [];
		createSoundSync(mainChannel, (message) => mainReceived.push(message));
		const tearOff = createSoundSync(tearOffChannel, (message) =>
			tearOffReceived.push(message)
		);
		tearOff.post({ kind: "stopped", conversationId: "conv-9", at: 42 });
		expect(mainReceived).toEqual([
			{ kind: "stopped", conversationId: "conv-9", at: 42 },
		]);
		expect(tearOffReceived).toEqual([]);
	});

	it("ignores malformed messages and survives a throwing handler", () => {
		const [a, b] = channelPair();
		const received: string[] = [];
		let fail = true;
		createSoundSync(b, (message) => {
			if (fail) {
				fail = false;
				throw new Error("bad");
			}
			received.push(message.kind);
		});
		a.postMessage({ kind: "nope" });
		a.postMessage({ kind: "played", key: "k", at: 1 });
		a.postMessage({ kind: "played", key: "k", at: 2 });
		expect(received).toEqual(["played"]);
	});

	it("never throws from post, and stops listening once disposed", () => {
		const [a, b] = channelPair();
		const received: SoundSyncMessage[] = [];
		const sender = createSoundSync(a, () => undefined);
		const receiver = createSoundSync(b, (message) => received.push(message));
		a.throwOnPost = true;
		expect(() =>
			sender.post({ kind: "played", key: "run:x", at: 1 })
		).not.toThrow();
		a.throwOnPost = false;
		receiver.dispose();
		receiver.dispose();
		expect(b.closed).toBe(true);
		sender.post({ kind: "played", key: "run:x", at: 2 });
		expect(received).toEqual([]);
	});

	it("is a no-op without a channel", () => {
		const sync = createSoundSync(null, () => {
			throw new Error("never called");
		});
		expect(() =>
			sync.post({ kind: "started", conversationId: "c", at: 1 })
		).not.toThrow();
		sync.dispose();
	});
});
