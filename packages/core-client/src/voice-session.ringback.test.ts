/// <reference lib="dom" />
import { afterEach, expect, test } from "bun:test";
import type { VoiceRingbackFactory } from "./voice-session.ts";
import { VoiceSessionConnection } from "./voice-session.ts";

// Bun supplies the real HTTP and WebSocket transport. Only the microphone (and,
// for `ready`, the capture AudioContext) are replaced.

interface RingCounter {
	factory: VoiceRingbackFactory;
	starts: () => number;
	stops: () => number;
}

function countingRingback(): RingCounter {
	let starts = 0;
	let stops = 0;
	return {
		factory: () => {
			starts += 1;
			return () => {
				stops += 1;
			};
		},
		starts: () => starts,
		stops: () => stops,
	};
}

const restorers: (() => void)[] = [];
afterEach(() => {
	for (const restore of restorers.splice(0).reverse()) {
		restore();
	}
});

function installGlobal(target: object, key: string, value: unknown): void {
	const descriptor = Object.getOwnPropertyDescriptor(target, key);
	Object.defineProperty(target, key, { configurable: true, value });
	restorers.push(() => {
		if (descriptor) {
			Object.defineProperty(target, key, descriptor);
		} else {
			Reflect.deleteProperty(target, key);
		}
	});
}

const fakeMicrophone = { getTracks: () => [{ stop: () => undefined }] };

function installMicrophone(acquire: () => Promise<unknown>): void {
	installGlobal(navigator, "mediaDevices", { getUserMedia: acquire });
}

function noopNode() {
	return { connect: () => undefined, disconnect: () => undefined };
}

/** Just enough of an AudioContext for `startCapture` after `ready`. */
class CaptureAudioContext {
	readonly destination = {};
	readonly sampleRate = 48_000;
	state = "running";
	close(): Promise<void> {
		this.state = "closed";
		return Promise.resolve();
	}
	createMediaStreamSource() {
		return noopNode();
	}
	createScriptProcessor() {
		return { ...noopNode(), onaudioprocess: null };
	}
}

interface VoiceServerFixture {
	/** Frames the server sends after the client's `start` frame. */
	afterStart?: object[];
	refuseTicket?: boolean;
}

function serveVoice({ afterStart = [], refuseTicket }: VoiceServerFixture) {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: (request, host) => {
			const { pathname } = new URL(request.url);
			if (pathname === "/api/ws/ticket") {
				return refuseTicket
					? Response.json({ error: "unavailable" }, { status: 503 })
					: Response.json({ ticket: "ring-ticket" });
			}
			if (pathname === "/api/voice/ws" && host.upgrade(request)) {
				return;
			}
			return new Response("not found", { status: 404 });
		},
		websocket: {
			message(socket, data) {
				const frame: { type?: string } = JSON.parse(String(data));
				if (frame.type === "end") {
					socket.send(
						JSON.stringify({
							type: "call_ended",
							content: "Ended",
							conversationId: "ring",
							messageId: "ring-message",
							durationSeconds: 0,
						})
					);
					return;
				}
				for (const reply of afterStart) {
					socket.send(JSON.stringify(reply));
				}
			},
		},
	});
	restorers.push(() => {
		server.stop(true);
	});
	return { url: server.url.href, token: "node-proof" };
}

test("a ringback factory rings once on start and stops once when the ticket is refused", async () => {
	installMicrophone(async () => fakeMicrophone);
	const ring = countingRingback();
	const connection = new VoiceSessionConnection(
		serveVoice({ refuseTicket: true }),
		{ ringback: ring.factory }
	);
	await expect(connection.start()).rejects.toThrow();
	expect(ring.starts()).toBe(1);
	expect(ring.stops()).toBe(1);
	connection.close();
	expect(ring.stops()).toBe(1);
});

test("hanging up while connecting stops the ringback exactly once", async () => {
	const microphone = Promise.withResolvers<unknown>();
	installMicrophone(() => microphone.promise);
	const ring = countingRingback();
	const connection = new VoiceSessionConnection(serveVoice({}), {
		ringback: ring.factory,
	});
	const starting = connection.start();
	expect(ring.starts()).toBe(1);
	expect(ring.stops()).toBe(0);
	connection.close();
	expect(ring.stops()).toBe(1);
	microphone.resolve(fakeMicrophone);
	await starting;
	connection.close();
	expect(ring.starts()).toBe(1);
	expect(ring.stops()).toBe(1);
});

test("a server error frame stops the ringback once and the later hang-up does not stop it again", async () => {
	installMicrophone(async () => fakeMicrophone);
	const ring = countingRingback();
	const errored = Promise.withResolvers<string>();
	const closed = Promise.withResolvers<void>();
	const connection = new VoiceSessionConnection(
		serveVoice({
			afterStart: [{ type: "error", code: "busy", message: "Core is busy" }],
		}),
		{
			ringback: ring.factory,
			handlers: {
				onError: (code) => errored.resolve(code),
				onClose: () => closed.resolve(),
			},
		}
	);
	await connection.start();
	expect(await errored.promise).toBe("busy");
	expect(ring.stops()).toBe(1);
	connection.close();
	await closed.promise;
	expect(ring.starts()).toBe(1);
	expect(ring.stops()).toBe(1);
});

test("ready stops the ringback once before the call goes live", async () => {
	installMicrophone(async () => fakeMicrophone);
	installGlobal(globalThis, "AudioContext", CaptureAudioContext);
	const ring = countingRingback();
	const ready = Promise.withResolvers<number>();
	const closed = Promise.withResolvers<void>();
	const connection = new VoiceSessionConnection(
		serveVoice({
			afterStart: [
				{ type: "ready", session_id: "ring", tts_sample_rate: 24_000 },
			],
		}),
		{
			ringback: ring.factory,
			handlers: {
				onReady: () => ready.resolve(ring.stops()),
				onClose: () => closed.resolve(),
			},
		}
	);
	await connection.start();
	// The ring is already silent by the time the UI hears `ready`.
	expect(await ready.promise).toBe(1);
	connection.close();
	await closed.promise;
	expect(ring.starts()).toBe(1);
	expect(ring.stops()).toBe(1);
});

test("a denied microphone stops the ringback and rejects start", async () => {
	installMicrophone(() => Promise.reject(new Error("permission denied")));
	const ring = countingRingback();
	const connection = new VoiceSessionConnection(serveVoice({}), {
		ringback: ring.factory,
	});
	await expect(connection.start()).rejects.toThrow("permission denied");
	expect(ring.starts()).toBe(1);
	expect(ring.stops()).toBe(1);
});

test("ringback false never rings and the built-in ring is skipped", async () => {
	installMicrophone(async () => fakeMicrophone);
	let builtInContexts = 0;
	installGlobal(
		globalThis,
		"AudioContext",
		class {
			constructor() {
				builtInContexts += 1;
			}
		}
	);
	const connection = new VoiceSessionConnection(
		serveVoice({ refuseTicket: true }),
		{ ringback: false }
	);
	await expect(connection.start()).rejects.toThrow();
	expect(builtInContexts).toBe(0);
});

test("omitting ringback keeps the built-in ring", async () => {
	installMicrophone(async () => fakeMicrophone);
	let builtInContexts = 0;
	installGlobal(
		globalThis,
		"AudioContext",
		class {
			constructor() {
				builtInContexts += 1;
				throw new Error("built-in ring reached");
			}
		}
	);
	const connection = new VoiceSessionConnection(
		serveVoice({ refuseTicket: true })
	);
	// The built-in ring failing to construct is contained like any factory, so
	// start rejects with the ticket refusal rather than the ring error.
	const failure = await connection.start().then(
		() => null,
		(error: unknown) => error
	);
	expect(failure).toBeInstanceOf(Error);
	expect(String(failure)).not.toContain("built-in ring reached");
	expect(builtInContexts).toBe(1);
});

test("a throwing ringback factory does not reject start or block the call", async () => {
	installMicrophone(async () => fakeMicrophone);
	const opened = Promise.withResolvers<void>();
	const closed = Promise.withResolvers<void>();
	const connection = new VoiceSessionConnection(serveVoice({}), {
		ringback: () => {
			throw new Error("no audio device");
		},
		handlers: {
			onOpen: () => opened.resolve(),
			onClose: () => closed.resolve(),
		},
	});
	await connection.start();
	await opened.promise;
	connection.close();
	await closed.promise;
});
