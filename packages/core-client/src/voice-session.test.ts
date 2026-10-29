/// <reference lib="dom" />
import { expect, test } from "bun:test";
import type { RvpCallEnded } from "@ryuhq/protocol/voice";
import { z } from "zod";
import { VoiceSessionConnection } from "./voice-session.ts";

function installMicrophone(acquire: () => Promise<FixtureMicrophone>) {
	const descriptor = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
	Object.defineProperty(navigator, "mediaDevices", {
		configurable: true,
		value: { getUserMedia: acquire },
	});
	return () => {
		if (descriptor) {
			Object.defineProperty(navigator, "mediaDevices", descriptor);
		} else {
			Reflect.deleteProperty(navigator, "mediaDevices");
		}
	};
}

// Bun supplies the real HTTP, WebSocket and MessageEvent transport. This test
// replaces only microphone acquisition; ready/audio capture is browser-verified.
interface FixtureMicrophone {
	getTracks: () => { stop: () => void }[];
}

test("canceling pending microphone acquisition stops the late track without requesting a ticket", async () => {
	let releaseMicrophone: (value: FixtureMicrophone) => void = () => undefined;
	const acquired = new Promise<FixtureMicrophone>((resolve) => {
		releaseMicrophone = resolve;
	});
	let stops = 0;
	let requests = 0;
	const restore = installMicrophone(() => acquired);
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => {
			requests += 1;
			return Response.json({ ticket: "unexpected-ticket" });
		},
	});
	const connection = new VoiceSessionConnection({
		url: server.url.href,
		token: "node-proof",
	});
	try {
		const starting = connection.start();
		connection.close();
		releaseMicrophone({
			getTracks: () => [
				{
					stop: () => {
						stops += 1;
					},
				},
			],
		});
		await starting;
		expect(stops).toBe(1);
		expect(requests).toBe(0);
		await connection.start();
		expect(requests).toBe(0);
		expect(stops).toBe(1);
	} finally {
		connection.close();
		await server.stop(true);
		restore();
	}
});

test("canceling a pending native ticket response conserves tracks and never opens a socket", async () => {
	let acknowledgeRequest: () => void = () => undefined;
	const requested = new Promise<void>((resolve) => {
		acknowledgeRequest = resolve;
	});
	let releaseTicket: () => void = () => undefined;
	const ticketReady = new Promise<void>((resolve) => {
		releaseTicket = resolve;
	});
	let stops = 0;
	const paths: string[] = [];
	const restore = installMicrophone(async () => ({
		getTracks: () => [
			{
				stop: () => {
					stops += 1;
				},
			},
		],
	}));
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: async (request) => {
			paths.push(new URL(request.url).pathname);
			expect(request.headers.get("authorization")).toBe("Bearer node-proof");
			acknowledgeRequest();
			await ticketReady;
			return Response.json({ ticket: "late-ticket" });
		},
	});
	const connection = new VoiceSessionConnection({
		url: server.url.href,
		token: "node-proof",
	});
	try {
		const starting = connection.start();
		await requested;
		connection.close();
		expect(stops).toBe(1);
		releaseTicket();
		await starting;
		expect(paths).toEqual(["/api/ws/ticket"]);
		expect(stops).toBe(1);
	} finally {
		releaseTicket();
		connection.close();
		await server.stop(true);
		restore();
	}
});

test("native ticket refusal releases the microphone and retry acknowledges one native socket start and end", async () => {
	let acquisitions = 0;
	let stops = 0;
	let tickets = 0;
	let upgrades = 0;
	const frames: unknown[] = [];
	const startAcknowledged = Promise.withResolvers<void>();
	let acknowledgeClose: () => void = () => undefined;
	const closed = new Promise<void>((resolve) => {
		acknowledgeClose = resolve;
	});
	const restore = installMicrophone(async () => {
		acquisitions += 1;
		return {
			getTracks: () => [
				{
					stop: () => {
						stops += 1;
					},
				},
			],
		};
	});
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: async (request, host) => {
			const url = new URL(request.url);
			if (url.pathname === "/api/ws/ticket") {
				tickets += 1;
				expect(request.headers.get("authorization")).toBe("Bearer node-proof");
				expect(await request.json()).toEqual({
					route: "voice",
					roomId: "retry-conversation",
				});
				return tickets === 1
					? Response.json(
							{ error: "ticket temporarily unavailable" },
							{ status: 503 }
						)
					: Response.json({ ticket: "retry-ticket" });
			}
			if (url.pathname === "/api/voice/ws") {
				upgrades += 1;
				expect([...url.searchParams]).toEqual([["ticket", "retry-ticket"]]);
				if (host.upgrade(request)) {
					return;
				}
			}
			return new Response("not found", { status: 404 });
		},
		websocket: {
			message(socket, data) {
				const wire = JSON.parse(String(data));
				if (wire.type === "end") {
					expect(wire).toEqual({ type: "end" });
					socket.send(
						JSON.stringify({
							type: "call_ended",
							content: "Acknowledged end",
							conversationId: "retry-conversation",
							messageId: "retry-message",
							durationSeconds: 0,
						})
					);
					return;
				}
				frames.push(startFrameSchema.parse(wire));
				startAcknowledged.resolve();
			},
		},
	});
	const connection = new VoiceSessionConnection(
		{ url: server.url.href, token: "node-proof" },
		{
			conversationId: "retry-conversation",
			handlers: { onClose: acknowledgeClose },
		}
	);
	try {
		await expect(connection.start()).rejects.toThrow();
		expect(acquisitions).toBe(1);
		expect(stops).toBe(1);
		expect(upgrades).toBe(0);
		await connection.start();
		await startAcknowledged.promise;
		// Exercise the shipping end/summary handshake before awaiting native
		// listener closure. Bun's peer-initiated close left its server pending
		// count nonzero even after both close callbacks, so that old boundary
		// remains a retained native-fixture failure rather than claimed success.
		connection.close();
		await closed;
		expect(tickets).toBe(2);
		expect(upgrades).toBe(1);
		expect(acquisitions).toBe(2);
		expect(stops).toBe(2);
		expect(frames).toEqual([
			{
				type: "start",
				sample_rate: 16_000,
				conversation_id: "retry-conversation",
			},
		]);
	} finally {
		connection.close();
		await server.stop(true);
		restore();
	}
});
const startFrameSchema = z.object({
	type: z.literal("start"),
	sample_rate: z.literal(16_000),
	conversation_id: z.string(),
});
const summaryFrame =
	'{"type":"call_ended","content":"Saved summary","conversationId":"conversation-1","messageId":"message-1","durationSeconds":37,"future":{"retained":true},"__proto__":{"opaque":"retained"}}';

test("dispatches valid native socket callbacks and ignores malformed known or future frames", async () => {
	const microphoneDescriptor = Object.getOwnPropertyDescriptor(
		navigator,
		"mediaDevices"
	);
	let tracksStopped = 0;
	const microphone: FixtureMicrophone = {
		getTracks: () => [
			{
				stop: () => {
					tracksStopped += 1;
				},
			},
		],
	};
	Object.defineProperty(navigator, "mediaDevices", {
		configurable: true,
		value: { getUserMedia: async () => microphone },
	});
	const callbacks: string[] = [];
	const startFrames: z.output<typeof startFrameSchema>[] = [];
	const upgrades: URL[] = [];
	let ticketRequests = 0;
	let resolveClosed: () => void = () => undefined;
	const closed = new Promise<void>((resolve) => {
		resolveClosed = resolve;
	});
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: async (request, host) => {
			const url = new URL(request.url);
			if (url.pathname === "/api/ws/ticket") {
				ticketRequests += 1;
				expect(request.headers.get("authorization")).toBe("Bearer node-proof");
				expect(await request.json()).toEqual({
					route: "voice",
					roomId: "conversation-1",
				});
				return Response.json({ ticket: "opaque-voice-ticket" });
			}
			if (url.pathname === "/api/voice/ws") {
				upgrades.push(url);
				if (host.upgrade(request)) {
					return;
				}
			}
			return new Response("not found", { status: 404 });
		},
		websocket: {
			message(socket, data) {
				const text = z.string().safeParse(data);
				if (!text.success) {
					return;
				}
				const frame = startFrameSchema.safeParse(JSON.parse(text.data));
				if (!frame.success) {
					return;
				}
				startFrames.push(frame.data);
				const frames = [
					{ type: "ready" },
					{ type: "state", value: "unsupported-state" },
					{ type: "stt", text: 14, final: "true" },
					{ type: "chat_delta", text: 14 },
					{ type: "chat_end", conversation_id: 14 },
					{ type: "error", code: 14, message: false },
					{ type: "future_voice_event", metadata: { ignored: true } },
					{ type: "state", value: "listening" },
					{ type: "speech_start" },
					{ type: "stt", text: "Partial transcript", final: false },
					{ type: "stt", text: "Final transcript", final: true },
					{ type: "chat_delta", text: "Caption delta" },
					{ type: "chat_end", conversation_id: "conversation-1" },
					{ type: "tts_start" },
					{ type: "tts_end" },
					{ type: "pong" },
					{ type: "stop_playback" },
					{ type: "error", code: "known-error", message: "Known error" },
				];
				socket.send("{broken JSON");
				for (const message of frames) {
					socket.send(JSON.stringify(message));
				}
				socket.send(summaryFrame);
			},
		},
	});
	const connection = new VoiceSessionConnection(
		{
			url: `http://127.0.0.1:${server.port}`,
			token: "node-proof",
			userJwt: "user-proof",
		},
		{
			conversationId: "conversation-1",
			handlers: {
				onOpen: () => callbacks.push("open"),
				onReady: () => callbacks.push("ready"),
				onState: (value) => callbacks.push(`state:${value}`),
				onSpeechStart: () => callbacks.push("speech_start"),
				onTranscript: (text, final) => callbacks.push(`stt:${text}:${final}`),
				onDelta: (text) => callbacks.push(`delta:${text}`),
				onChatEnd: (id) => callbacks.push(`chat_end:${id}`),
				onError: (code, message) => callbacks.push(`error:${code}:${message}`),
				onCallEnded: (summary: RvpCallEnded) =>
					callbacks.push(JSON.stringify(summary)),
				onClose: () => {
					callbacks.push("close");
					resolveClosed();
				},
			},
		}
	);
	try {
		await connection.start();
		await closed;
		expect(callbacks).toEqual([
			"open",
			"state:listening",
			"speech_start",
			"stt:Partial transcript:false",
			"stt:Final transcript:true",
			"delta:Caption delta",
			"chat_end:conversation-1",
			"error:known-error:Known error",
			summaryFrame,
			"close",
		]);
		expect(startFrames).toEqual([
			{ type: "start", sample_rate: 16_000, conversation_id: "conversation-1" },
		]);
		expect(ticketRequests).toBe(1);
		expect(upgrades).toHaveLength(1);
		const upgrade = upgrades[0];
		if (!upgrade) {
			throw new Error("native socket upgrade must be captured");
		}
		expect([...upgrade.searchParams]).toEqual([
			["ticket", "opaque-voice-ticket"],
		]);
		expect(upgrade.toString()).not.toContain("node-proof");
		expect(upgrade.toString()).not.toContain("user-proof");
		expect(tracksStopped).toBe(1);
	} finally {
		connection.close();
		await server.stop(true);
		if (microphoneDescriptor) {
			Object.defineProperty(navigator, "mediaDevices", microphoneDescriptor);
		} else {
			Reflect.deleteProperty(navigator, "mediaDevices");
		}
	}
}, 10_000);

function stoppingMicrophone(onStop: () => void): FixtureMicrophone {
	return { getTracks: () => [{ stop: onStop }] };
}

// Bun 1.3.14 keeps a server-initiated WebSocket close pending in the serving
// process, so `server.stop(true)` never settles there. The remote-close peer
// therefore runs as its own native Bun process; teardown awaits its exit.
const remoteClosePeerSource = `
const report = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch(request, host) {
		const url = new URL(request.url);
		if (url.pathname === "/api/ws/ticket") {
			report({ event: "ticket", authorization: request.headers.get("authorization") });
			return Response.json({ ticket: "remote-close-ticket" });
		}
		if (url.pathname === "/api/voice/ws") {
			report({ event: "upgrade", ticket: url.searchParams.get("ticket") });
			if (host.upgrade(request)) return;
		}
		return new Response("not found", { status: 404 });
	},
	websocket: {
		message(socket, data) {
			report({ event: "frame", frame: JSON.parse(String(data)) });
			// Core reports a processing failure, then ends the call itself.
			socket.send(JSON.stringify({ type: "error", code: "stt_unavailable", message: "Speech engine stopped" }));
			socket.close(1011, "engine failure");
		},
		close(_socket, code) {
			report({ event: "close", code });
		},
	},
});
report({ event: "listening", port: server.port });
`;
const peerEventSchema = z.discriminatedUnion("event", [
	z.object({ event: z.literal("listening"), port: z.number() }),
	z.object({
		event: z.literal("ticket"),
		authorization: z.string().nullable(),
	}),
	z.object({ event: z.literal("upgrade"), ticket: z.string().nullable() }),
	z.object({ event: z.literal("frame"), frame: z.unknown() }),
	z.object({ event: z.literal("close"), code: z.number() }),
]);
type PeerEvent = z.output<typeof peerEventSchema>;

function spawnRemoteClosePeer() {
	const peer = Bun.spawn([process.execPath, "-e", remoteClosePeerSource], {
		stderr: "inherit",
		stdout: "pipe",
	});
	const events: PeerEvent[] = [];
	// Set once stdout reaches EOF or cannot be parsed: no further event arrives.
	let outputStopped = false;
	let readFailure: unknown;
	let pending = "";
	let changed = Promise.withResolvers<void>();
	const reading = (async () => {
		const decoder = new TextDecoder();
		const reader = peer.stdout.getReader();
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}
				pending += decoder.decode(value, { stream: true });
				let newline = pending.indexOf("\n");
				while (newline >= 0) {
					events.push(
						peerEventSchema.parse(JSON.parse(pending.slice(0, newline)))
					);
					pending = pending.slice(newline + 1);
					newline = pending.indexOf("\n");
				}
				changed.resolve();
				changed = Promise.withResolvers<void>();
			}
		} catch (error) {
			readFailure = error;
		} finally {
			outputStopped = true;
			changed.resolve();
		}
	})();
	async function waitFor<T extends PeerEvent["event"]>(event: T) {
		for (;;) {
			const found = events.find((entry) => entry.event === event);
			if (found) {
				return found as Extract<PeerEvent, { event: T }>;
			}
			if (outputStopped) {
				// Fail with the peer's state instead of re-awaiting a settled promise,
				// which would starve the event loop and the per-test timeout. EOF means
				// the peer is exiting, so its exit status is awaited for the message.
				const exit =
					readFailure === undefined ? await peer.exited : peer.exitCode;
				throw new Error(
					`peer output stopped before ${event}: exit ${exit ?? "pending"}, signal ${peer.signalCode ?? "none"}, events [${events.map((entry) => entry.event).join(", ")}], unparsed output ${JSON.stringify(pending)}`,
					{ cause: readFailure }
				);
			}
			await changed.promise;
		}
	}
	async function stop() {
		peer.kill();
		await peer.exited;
		await reading;
	}
	return { events, stop, waitFor };
}

test("a remote error frame followed by a peer close releases the microphone once and leaves the call closed", async () => {
	let stops = 0;
	const callbacks: string[] = [];
	const closed = Promise.withResolvers<void>();
	const restore = installMicrophone(async () =>
		stoppingMicrophone(() => {
			stops += 1;
		})
	);
	const peer = spawnRemoteClosePeer();
	try {
		const { port } = await peer.waitFor("listening");
		const connection = new VoiceSessionConnection(
			{ url: `http://127.0.0.1:${port}`, token: "node-proof" },
			{
				conversationId: "remote-close",
				handlers: {
					onOpen: () => callbacks.push("open"),
					onError: (code, message) =>
						callbacks.push(`error:${code}:${message}`),
					onClose: () => {
						callbacks.push("close");
						closed.resolve();
					},
				},
			}
		);
		try {
			await connection.start();
			await closed.promise;
			expect((await peer.waitFor("close")).code).toBe(1011);
			expect(callbacks).toEqual([
				"open",
				"error:stt_unavailable:Speech engine stopped",
				"close",
			]);
			expect(stops).toBe(1);
			// The UI's later hang-up and a stale restart are no-ops: no end frame,
			// no second ticket, socket or microphone release.
			connection.close();
			await connection.start();
			expect(stops).toBe(1);
			expect(callbacks).toHaveLength(3);
		} finally {
			connection.close();
		}
	} finally {
		await peer.stop();
		restore();
	}
	expect(peer.events.filter((entry) => entry.event !== "listening")).toEqual([
		{ event: "ticket", authorization: "Bearer node-proof" },
		{ event: "upgrade", ticket: "remote-close-ticket" },
		{
			event: "frame",
			frame: {
				type: "start",
				sample_rate: 16_000,
				conversation_id: "remote-close",
			},
		},
		{ event: "close", code: 1011 },
	]);
});

test("a refused native upgrade reports one socket error, closes once and releases the microphone", async () => {
	let stops = 0;
	let tickets = 0;
	const upgradeTickets: string[] = [];
	const callbacks: string[] = [];
	const closed = Promise.withResolvers<void>();
	const restore = installMicrophone(async () =>
		stoppingMicrophone(() => {
			stops += 1;
		})
	);
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: (request) => {
			const url = new URL(request.url);
			if (url.pathname === "/api/ws/ticket") {
				tickets += 1;
				return Response.json({ ticket: "expired-ticket" });
			}
			if (url.pathname === "/api/voice/ws") {
				upgradeTickets.push(url.searchParams.get("ticket") ?? "");
				return new Response("ticket expired", { status: 401 });
			}
			return new Response("not found", { status: 404 });
		},
	});
	const connection = new VoiceSessionConnection(
		{ url: server.url.href, token: "node-proof" },
		{
			handlers: {
				onOpen: () => callbacks.push("open"),
				onError: (code, message) => callbacks.push(`error:${code}:${message}`),
				onClose: () => {
					callbacks.push("close");
					closed.resolve();
				},
			},
		}
	);
	try {
		await connection.start();
		await closed.promise;
		expect(callbacks).toEqual(["error:socket:voice socket error", "close"]);
		expect(upgradeTickets).toEqual(["expired-ticket"]);
		expect(stops).toBe(1);
		await connection.start();
		expect(tickets).toBe(1);
		expect(upgradeTickets).toHaveLength(1);
		expect(stops).toBe(1);
	} finally {
		connection.close();
		await server.stop(true);
		restore();
	}
});

test("hanging up while the native socket is still connecting closes without reporting a transport error", async () => {
	let stops = 0;
	const frames: unknown[] = [];
	const upgradeArrived = Promise.withResolvers<void>();
	const releaseUpgrade = Promise.withResolvers<void>();
	const upgradeSettled = Promise.withResolvers<boolean>();
	const callbacks: string[] = [];
	const closed = Promise.withResolvers<void>();
	const restore = installMicrophone(async () =>
		stoppingMicrophone(() => {
			stops += 1;
		})
	);
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: async (request, host) => {
			const url = new URL(request.url);
			if (url.pathname === "/api/ws/ticket") {
				return Response.json({ ticket: "pending-ticket" });
			}
			if (url.pathname === "/api/voice/ws") {
				upgradeArrived.resolve();
				await releaseUpgrade.promise;
				const upgraded = host.upgrade(request);
				upgradeSettled.resolve(upgraded);
				if (upgraded) {
					return;
				}
				return new Response("client went away", { status: 400 });
			}
			return new Response("not found", { status: 404 });
		},
		websocket: {
			message(_socket, data) {
				frames.push(data);
			},
		},
	});
	const connection = new VoiceSessionConnection(
		{ url: server.url.href, token: "node-proof" },
		{
			handlers: {
				onOpen: () => callbacks.push("open"),
				onError: (code, message) => callbacks.push(`error:${code}:${message}`),
				onClose: () => {
					callbacks.push("close");
					closed.resolve();
				},
			},
		}
	);
	try {
		await connection.start();
		await upgradeArrived.promise;
		connection.close();
		expect(stops).toBe(1);
		await closed.promise;
		releaseUpgrade.resolve();
		await upgradeSettled.promise;
		// A deliberate hang-up is not a transport failure the UI should surface.
		expect(callbacks).toEqual(["close"]);
		expect(stops).toBe(1);
		expect(frames).toEqual([]);
	} finally {
		releaseUpgrade.resolve();
		connection.close();
		await server.stop(true);
		restore();
	}
});
