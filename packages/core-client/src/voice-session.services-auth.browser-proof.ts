/// <reference lib="dom" />
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	type AddressInfo,
	createServer,
	type Server,
	type Socket,
} from "node:net";
import { resolve } from "node:path";

// services-auth browser proof for the shipping `VoiceSessionConnection`.
//
// Bun's client WebSocket never fires `error` on an open socket, so the
// "transport error after hanging up an open call" path can only be observed in
// a browser. This file bundles the real client for Chromium, serves it from a
// local raw TCP peer that also implements the node's ticket and voice-socket
// endpoints, and drives it with Playwright's Chromium (fake-device microphone,
// real Web Audio and real browser WebSocket).
//
// Not discovered by `bun test` on its own (no `.test.` in the name, it needs
// Chromium). Run it explicitly:
//   flock /tmp/ryu-heavy.lock -c 'bun test ./src/voice-session.services-auth.browser-proof.ts'
// SERVICES_AUTH_VOICE_SOURCE may name a replacement `voice-session.ts` source
// (a scratch mutant) that the bundle serves instead of the shipping file.
const CHROMIUM =
	process.env.SERVICES_AUTH_CHROMIUM ??
	"/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const PLAYWRIGHT = Bun.resolveSync(
	"@playwright/test",
	resolve(import.meta.dir, "../../../apps/desktop")
);
// Playwright is resolved from the Desktop app's install; only the calls this
// proof makes are typed here.
interface ProofPage {
	close(): Promise<void>;
	evaluate<Result, Arg>(
		run: (arg: Arg) => Result | Promise<Result>,
		arg: Arg
	): Promise<Result>;
	evaluate<Result>(run: () => Result | Promise<Result>): Promise<Result>;
	goto(url: string): Promise<unknown>;
	on(event: "pageerror", listener: (error: Error) => void): void;
}
interface ProofBrowser {
	close(): Promise<void>;
	newPage(): Promise<ProofPage>;
}
const { chromium } = (await import(PLAYWRIGHT)) as {
	chromium: {
		launch(options: {
			args: string[];
			executablePath: string;
			headless: boolean;
		}): Promise<ProofBrowser>;
	};
};

type Peer =
	| "summary-then-close"
	| "reset-on-end"
	| "invalid-frame-on-end"
	| "hold-upgrade";
interface Observation {
	events: string[];
	micLive: string[];
	micStops: number;
}

let bundle = "";
let origin = "";
let peerServer: Server | undefined;
let browser: ProofBrowser | undefined;
const tickets: { authorization: string | null; body: unknown }[] = [];
const peerFrames: string[] = [];
const openSockets = new Set<Socket>();
let releaseUpgrade: (() => void) | undefined;
let currentPeer: Peer = "summary-then-close";
function releaseHeldUpgrade(): void {
	releaseUpgrade?.();
}
// Microphone PCM the peer received as binary frames, in total and after the
// client's `end` (a hung-up call must not keep sending microphone audio).
const uplink = { afterEnd: 0, endSeen: false, frames: 0 };
// The peer's answer to `end` (summary, reset or corrupted frame) waits for the
// test, so the window between hang-up and that answer can be observed.
let pendingEndReply: (() => void) | undefined;
function releaseEndReply(): void {
	const reply = pendingEndReply;
	pendingEndReply = undefined;
	reply?.();
}

async function buildBundle(): Promise<string> {
	const replacement = process.env.SERVICES_AUTH_VOICE_SOURCE;
	const shipping = resolve(import.meta.dir, "voice-session.ts");
	const result = await Bun.build({
		entrypoints: [
			resolve(import.meta.dir, "voice-session.services-auth.browser-entry.ts"),
		],
		plugins: replacement
			? [
					{
						name: "services-auth-voice-mutant",
						setup(build) {
							build.onLoad({ filter: /voice-session\.ts$/ }, async (args) => {
								if (args.path !== shipping) {
									throw new Error(`unexpected module ${args.path}`);
								}
								return {
									contents: await Bun.file(replacement).text(),
									loader: "ts",
								};
							});
						},
					},
				]
			: [],
		target: "browser",
	});
	const [output] = result.outputs;
	if (!(result.success && output)) {
		throw new Error(`bundle failed: ${result.logs.join("\n")}`);
	}
	return await output.text();
}

// ── A raw HTTP/WebSocket peer ────────────────────────────────────────────────
// Bun.serve cannot send a malformed frame or reset a TCP connection, so the
// node's ticket and voice-socket endpoints are implemented over plain TCP: the
// RFC 6455 handshake, masked client frames in, unmasked server frames out.
function httpReply(socket: Socket, status: string, type: string, body: string) {
	socket.end(
		`HTTP/1.1 ${status}\r\ncontent-type: ${type}\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`
	);
}
function serverFrame(opcode: number, payload: Buffer): Buffer {
	const header =
		payload.length < 126
			? Buffer.from([0x80 | opcode, payload.length])
			: Buffer.from([
					0x80 | opcode,
					126,
					payload.length >> 8,
					payload.length & 0xff,
				]);
	return Buffer.concat([header, payload]);
}
function sendText(socket: Socket, value: unknown): void {
	socket.write(serverFrame(0x1, Buffer.from(JSON.stringify(value))));
}
/** Split complete masked client frames off the buffer. */
function readFrames(buffer: Buffer): {
	frames: { opcode: number; payload: Buffer }[];
	rest: Buffer;
} {
	const frames: { opcode: number; payload: Buffer }[] = [];
	let offset = 0;
	for (;;) {
		if (buffer.length - offset < 2) {
			break;
		}
		const opcode = (buffer[offset] ?? 0) & 0x0f;
		let length = (buffer[offset + 1] ?? 0) & 0x7f;
		let cursor = offset + 2;
		if (length === 126) {
			if (buffer.length < cursor + 2) {
				break;
			}
			length = buffer.readUInt16BE(cursor);
			cursor += 2;
		} else if (length === 127) {
			if (buffer.length < cursor + 8) {
				break;
			}
			length = Number(buffer.readBigUInt64BE(cursor));
			cursor += 8;
		}
		if (buffer.length < cursor + 4 + length) {
			break;
		}
		const mask = buffer.subarray(cursor, cursor + 4);
		const payload = Buffer.from(
			buffer.subarray(cursor + 4, cursor + 4 + length)
		);
		for (let index = 0; index < payload.length; index += 1) {
			payload[index] = (payload[index] ?? 0) ^ (mask[index % 4] ?? 0);
		}
		frames.push({ opcode, payload });
		offset = cursor + 4 + length;
	}
	return { frames, rest: buffer.subarray(offset) };
}

function onControlFrame(socket: Socket, peer: Peer, raw: string): void {
	const frame = JSON.parse(raw) as { type?: string };
	peerFrames.push(frame.type ?? "unknown");
	if (frame.type === "start") {
		sendText(socket, {
			session_id: "browser-proof-session",
			tts_sample_rate: 24_000,
			type: "ready",
		});
		return;
	}
	if (frame.type !== "end") {
		return;
	}
	uplink.endSeen = true;
	pendingEndReply = () => answerEnd(socket, peer);
}

function answerEnd(socket: Socket, peer: Peer): void {
	if (peer === "reset-on-end") {
		// The node dies while the client waits for its summary: TCP reset, no
		// close frame.
		socket.resetAndDestroy();
		return;
	}
	if (peer === "invalid-frame-on-end") {
		// A corrupted text frame (invalid UTF-8): the browser must fail the socket.
		socket.write(serverFrame(0x1, Buffer.from([0xff, 0xfe, 0xfd])));
		return;
	}
	sendText(socket, {
		content: "Saved summary",
		conversationId: "browser-proof-conversation",
		durationSeconds: 1,
		messageId: "browser-proof-message",
		type: "call_ended",
	});
	socket.end(serverFrame(0x8, Buffer.from([0x03, 0xe8])));
}

function acceptWebSocket(
	socket: Socket,
	headers: Map<string, string>,
	peer: Peer
) {
	// RFC 6455 §4.2.2 fixes SHA-1 for Sec-WebSocket-Accept; it is a handshake
	// checksum, not a security digest.
	// nosemgrep: tools.watch.ryu-weak-crypto
	const accept = createHash("sha1")
		.update(
			`${headers.get("sec-websocket-key") ?? ""}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`
		)
		.digest("base64");
	socket.write(
		`HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ${accept}\r\n\r\n`
	);
	let pending: Buffer = Buffer.alloc(0);
	socket.on("data", (chunk: Buffer) => {
		const { frames, rest } = readFrames(Buffer.concat([pending, chunk]));
		pending = rest;
		for (const frame of frames) {
			if (frame.opcode === 0x1) {
				onControlFrame(socket, peer, frame.payload.toString("utf8"));
			} else if (frame.opcode === 0x2) {
				uplink.frames += 1;
				if (uplink.endSeen) {
					uplink.afterEnd += 1;
				}
			} else if (frame.opcode === 0x8) {
				peerFrames.push("client-close");
				socket.end(serverFrame(0x8, frame.payload.subarray(0, 2)));
			}
		}
	});
}

function handleConnection(socket: Socket): void {
	openSockets.add(socket);
	socket.on("close", () => openSockets.delete(socket));
	socket.on("error", () => undefined);
	let head: Buffer = Buffer.alloc(0);
	const onHead = async (chunk: Buffer) => {
		head = Buffer.concat([head, chunk]);
		const end = head.indexOf("\r\n\r\n");
		if (end === -1) {
			return;
		}
		socket.off("data", onHead);
		const [requestLine = "", ...lines] = head
			.subarray(0, end)
			.toString()
			.split("\r\n");
		const [method, target = "/"] = requestLine.split(" ");
		const headers = new Map(
			lines.map((line) => {
				const separator = line.indexOf(":");
				return [
					line.slice(0, separator).trim().toLowerCase(),
					line.slice(separator + 1).trim(),
				] as const;
			})
		);
		const path = new URL(target, origin).pathname;
		let body = head.subarray(end + 4);
		if (path === "/") {
			httpReply(
				socket,
				"200 OK",
				"text/html",
				'<!doctype html><meta charset="utf-8"><title>voice proof</title><script src="/bundle.js"></script>'
			);
			return;
		}
		if (path === "/bundle.js") {
			httpReply(socket, "200 OK", "text/javascript", bundle);
			return;
		}
		if (path === "/api/ws/ticket" && method === "POST") {
			const length = Number(headers.get("content-length") ?? "0");
			while (body.length < length) {
				body = Buffer.concat([
					body,
					await new Promise<Buffer>((resolveChunk) =>
						socket.once("data", resolveChunk)
					),
				]);
			}
			tickets.push({
				authorization: headers.get("authorization") ?? null,
				body: JSON.parse(body.toString("utf8")),
			});
			httpReply(
				socket,
				"200 OK",
				"application/json",
				JSON.stringify({ ticket: `ticket-${tickets.length}` })
			);
			return;
		}
		if (path === "/api/voice/ws") {
			const peer = currentPeer;
			if (peer === "hold-upgrade") {
				// Keep the browser socket CONNECTING until the test releases it.
				await new Promise<void>((resolveUpgrade) => {
					releaseUpgrade = resolveUpgrade;
				});
				socket.destroy();
				return;
			}
			acceptWebSocket(socket, headers, peer);
			return;
		}
		httpReply(socket, "404 Not Found", "text/plain", "not found");
	};
	socket.on("data", onHead);
}

beforeAll(async () => {
	bundle = await buildBundle();
	peerServer = createServer(handleConnection);
	await new Promise<void>((resolveListen) =>
		peerServer?.listen(0, "127.0.0.1", resolveListen)
	);
	origin = `http://127.0.0.1:${(peerServer.address() as AddressInfo).port}/`;
	browser = await chromium.launch({
		args: [
			"--use-fake-device-for-media-stream",
			"--use-fake-ui-for-media-stream",
			"--autoplay-policy=no-user-gesture-required",
		],
		executablePath: CHROMIUM,
		headless: true,
	});
}, 60_000);

afterAll(async () => {
	releaseHeldUpgrade();
	releaseEndReply();
	await browser?.close();
	for (const socket of openSockets) {
		socket.destroy();
	}
	await new Promise<void>((resolveClose) =>
		peerServer?.close(() => resolveClose())
	);
});

async function openCall(peer: Peer) {
	if (!(browser && peerServer)) {
		throw new Error("browser proof is not running");
	}
	currentPeer = peer;
	tickets.length = 0;
	peerFrames.length = 0;
	pendingEndReply = undefined;
	Object.assign(uplink, { afterEnd: 0, endSeen: false, frames: 0 });
	const page = await browser.newPage();
	const consoleErrors: string[] = [];
	page.on("pageerror", (error) => consoleErrors.push(String(error)));
	await page.goto(origin);
	const nodeUrl = origin;
	const observe = async (): Promise<Observation> =>
		(await page.evaluate(() =>
			(
				window as unknown as {
					voiceProof: { snapshot: () => Observation };
				}
			).voiceProof.snapshot()
		)) as Observation;
	const waitForEvents = async (label: string, count: number) => {
		const deadline = Date.now() + 10_000;
		for (;;) {
			const observed = await observe();
			if (observed.events.length >= count) {
				return observed;
			}
			if (Date.now() > deadline) {
				throw new Error(
					`timed out waiting for ${label}: ${JSON.stringify(observed)}`
				);
			}
			await Bun.sleep(50);
		}
	};
	const hangUp = () =>
		page.evaluate(() =>
			(
				window as unknown as { voiceProof: { hangUp: () => void } }
			).voiceProof.hangUp()
		);
	const waitForPeer = async (label: string, ready: () => boolean) => {
		const deadline = Date.now() + 10_000;
		while (!ready()) {
			if (Date.now() > deadline) {
				throw new Error(`timed out waiting for ${label}`);
			}
			await Bun.sleep(25);
		}
	};
	return {
		consoleErrors,
		hangUp,
		/**
		 * Hang up an open call and observe it while the peer still holds its
		 * answer to `end` (the summary wait), for several capture buffers' worth
		 * of time in which a live microphone would keep sending PCM.
		 */
		async hangUpAwaitingAnswer() {
			await hangUp();
			await waitForPeer("the end frame", () => uplink.endSeen);
			await Bun.sleep(600);
			return { observed: await observe(), uplinkAfterEnd: uplink.afterEnd };
		},
		observe,
		page,
		start: () =>
			page.evaluate(
				(url) =>
					(
						window as unknown as {
							voiceProof: { startCall: (target: string) => Promise<string> };
						}
					).voiceProof.startCall(url),
				nodeUrl
			),
		waitForEvents,
		/** The microphone uplink is live: the peer has received PCM frames. */
		waitForUplink: () => waitForPeer("microphone PCM", () => uplink.frames > 0),
	};
}

test("a corrupted frame while waiting for the summary of a hung-up open call is reported as one transport error, then one close, with the microphone already released", async () => {
	const call = await openCall("invalid-frame-on-end");
	expect(await call.start()).toBe("started");
	const live = await call.waitForEvents("ready", 2);
	expect(live.events).toEqual(["open", "ready"]);
	expect(live.micLive).toEqual(["live"]);
	expect(tickets).toEqual([
		{
			authorization: "Bearer browser-proof-node",
			body: { route: "voice" },
		},
	]);

	await call.waitForUplink();

	// The hang-up releases the microphone at once and sends `end`: while the
	// node has not answered, the call is still open but no PCM leaves.
	const waiting = await call.hangUpAwaitingAnswer();
	expect(waiting.observed).toEqual({
		events: ["open", "ready"],
		micLive: ["ended"],
		micStops: 1,
	});
	expect(waiting.uplinkAfterEnd).toBe(0);
	releaseEndReply();
	// Chromium fails the open socket on the corrupted frame: `error`, then
	// `close`. The client reports that transport failure exactly once.
	const ended = await call.waitForEvents("error and close", 4);
	expect(ended.events).toEqual([
		"open",
		"ready",
		"error:socket:voice socket error",
		"close",
	]);
	expect(ended.micStops).toBe(1);
	// Chromium may also send its own close frame for the failed socket.
	expect(peerFrames.filter((frame) => frame !== "client-close")).toEqual([
		"start",
		"end",
	]);

	// A second hang-up is a no-op and nothing else arrives later.
	await call.hangUp();
	await Bun.sleep(300);
	expect(await call.observe()).toEqual(ended);
	expect(call.consoleErrors).toEqual([]);
	await call.page.close();
}, 30_000);

test("a node that drops the TCP connection after an open call is hung up closes the call once with no summary", async () => {
	const call = await openCall("reset-on-end");
	expect(await call.start()).toBe("started");
	await call.waitForEvents("ready", 2);
	await call.waitForUplink();
	const waiting = await call.hangUpAwaitingAnswer();
	expect(waiting.observed.micLive).toEqual(["ended"]);
	expect(waiting.uplinkAfterEnd).toBe(0);
	releaseEndReply();
	// Chromium reports an abrupt drop of an established socket as a close
	// without an `error` event, so there is no transport error to surface.
	const ended = await call.waitForEvents("close", 3);
	await Bun.sleep(300);
	expect(await call.observe()).toEqual(ended);
	expect(ended).toEqual({
		events: ["open", "ready", "close"],
		micLive: ["ended"],
		micStops: 1,
	});
	expect(peerFrames).toEqual(["start", "end"]);
	expect(call.consoleErrors).toEqual([]);
	await call.page.close();
}, 30_000);

test("hanging up an open call that receives its summary reports no transport error", async () => {
	const call = await openCall("summary-then-close");
	expect(await call.start()).toBe("started");
	await call.waitForEvents("ready", 2);
	await call.waitForUplink();
	const waiting = await call.hangUpAwaitingAnswer();
	expect(waiting.observed.events).toEqual(["open", "ready"]);
	expect(waiting.observed.micLive).toEqual(["ended"]);
	expect(waiting.uplinkAfterEnd).toBe(0);
	releaseEndReply();
	const ended = await call.waitForEvents("summary and close", 4);
	expect(ended.events).toEqual([
		"open",
		"ready",
		"call_ended:browser-proof-message",
		"close",
	]);
	expect(ended.micLive).toEqual(["ended"]);
	expect(ended.micStops).toBe(1);
	expect(peerFrames).toEqual(["start", "end"]);
	expect(call.consoleErrors).toEqual([]);
	await call.page.close();
}, 30_000);

test("hanging up while the browser socket is still connecting closes without reporting a transport error", async () => {
	// The peer holds the upgrade, so the browser socket stays CONNECTING after
	// start resolves.
	const call = await openCall("hold-upgrade");
	releaseUpgrade = undefined;
	expect(await call.start()).toBe("started");
	const deadline = Date.now() + 10_000;
	while (!releaseUpgrade && Date.now() < deadline) {
		await Bun.sleep(25);
	}
	expect(releaseUpgrade).toBeDefined();
	await call.hangUp();
	const ended = await call.waitForEvents("close", 1);
	releaseHeldUpgrade();
	await Bun.sleep(300);
	expect(await call.observe()).toEqual({
		events: ["close"],
		micLive: ["ended"],
		micStops: 1,
	});
	expect(ended.events).toEqual(["close"]);
	expect(peerFrames).toEqual([]);
	expect(call.consoleErrors).toEqual([]);
	await call.page.close();
}, 30_000);
