import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { z } from "zod";
import type { ClipContext } from "../lib/api/clips.ts";

// Authentication leaves only: recording state and HTTP serialization stay real.
mock.module("@/lib/auth-client.ts", () => ({
	TOKEN_KEY: "ryu_session_token",
	getActiveToken: () =>
		globalThis.localStorage?.getItem("ryu_session_token") ?? null,
}));
mock.module("@/src/lib/realtime/jwt.ts", () => ({
	getRealtimeJwt: () => null,
}));
const { useClipStore } = await import("./useClipStore.ts");
const originalFetch = globalThis.fetch;
const target = { url: "https://fixture.invalid", token: null };
const context: ClipContext = {
	id: "recording",
	durationMs: 4000,
	capture: { screen: true, mic: true, systemAudio: false },
	createdAt: "2026-10-05T00:00:00.000Z",
	diagnosticsPath: "/fixture/recording/diagnostics.json",
	framesEndpoint: "/api/clips/recording/frame",
	recommendedMoments: [{ atMs: 1000, reason: "Capture started" }],
	t0EpochMs: 1_791_158_400_000,
	title: "Recording fixture",
	transcriptPath: "/fixture/recording/transcript.json",
	video: "/fixture/recording/video.mp4",
};

function fixtureFetch(
	handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
): typeof fetch {
	return Object.assign(mock(handler), { preconnect: originalFetch.preconnect });
}
beforeEach(() =>
	useClipStore.setState({
		sessionScope: JSON.stringify([target.url, target.token, null]),
		status: "idle",
		clipId: null,
		startedAtMs: null,
		elapsedMs: 0,
		isPaused: false,
		pendingAction: null,
		error: null,
		lastContext: null,
		clips: [],
		sources: { mic: true, systemAudio: false },
		captureTarget: { kind: "screen" },
	})
);
afterEach(() => {
	globalThis.fetch = originalFetch;
});

test("recording start rejects duplicate in-flight requests and retains selections for retry", async () => {
	let finish!: (response: Response) => void;
	const calls: RequestInit[] = [];
	globalThis.fetch = fixtureFetch((_url, init) => {
		calls.push(init ?? {});
		return new Promise<Response>((resolve) => {
			finish = resolve;
		});
	});
	useClipStore.getState().setCaptureTarget({ kind: "window", windowId: 42 });
	const first = useClipStore.getState().start(target);
	await useClipStore.getState().start(target);
	await Promise.resolve();
	await Promise.resolve();
	expect(calls).toHaveLength(1);
	expect(JSON.parse(z.string().parse(calls[0].body))).toEqual({
		screen: true,
		mic: true,
		systemAudio: false,
		target: { kind: "window", windowId: 42 },
	});
	finish(Response.json({ available: false, reason: "permission denied" }));
	await first;
	expect(useClipStore.getState()).toMatchObject({
		status: "idle",
		clipId: null,
		error: "permission denied",
		captureTarget: { kind: "window", windowId: 42 },
	});
});

test("pause serializes resume and stop until backend settles and freezes authoritative duration", async () => {
	let finish!: (response: Response) => void;
	const calls: string[] = [];
	globalThis.fetch = fixtureFetch((url) => {
		calls.push(String(url));
		return new Promise<Response>((resolve) => {
			finish = resolve;
		});
	});
	useClipStore.setState({
		status: "recording",
		clipId: "recording",
		startedAtMs: Date.now() - 1000,
	});
	const pausing = useClipStore.getState().pause(target);
	await useClipStore.getState().resume(target);
	expect(await useClipStore.getState().stop(target)).toBeNull();
	await Promise.resolve();
	await Promise.resolve();
	expect(calls).toEqual(["https://fixture.invalid/api/clips/recording/pause"]);
	finish(Response.json(context));
	await pausing;
	useClipStore.getState().tick();
	expect(useClipStore.getState()).toMatchObject({
		isPaused: true,
		pendingAction: null,
		elapsedMs: 4000,
	});
});

test("failed stop keeps the recording identity and successful retry finalizes once", async () => {
	const calls: string[] = [];
	let attempts = 0;
	globalThis.fetch = fixtureFetch((url) => {
		calls.push(String(url));
		if (String(url).endsWith("/stop")) {
			return Promise.resolve(
				Response.json(
					++attempts === 1 ? { available: false, reason: "busy" } : context
				)
			);
		}
		return Promise.resolve(Response.json({ clips: [context] }));
	});
	useClipStore.setState({
		status: "recording",
		clipId: "recording",
		isPaused: true,
		elapsedMs: 4000,
	});
	expect(await useClipStore.getState().stop(target)).toBeNull();
	expect(useClipStore.getState()).toMatchObject({
		status: "recording",
		clipId: "recording",
		isPaused: true,
		error: "busy",
	});
	expect(await useClipStore.getState().stop(target)).toEqual(context);
	expect(useClipStore.getState()).toMatchObject({
		status: "idle",
		clipId: null,
		isPaused: false,
		lastContext: context,
		clips: [context],
	});
	expect(calls).toEqual([
		"https://fixture.invalid/api/clips/recording/stop",
		"https://fixture.invalid/api/clips/recording/stop",
		"https://fixture.invalid/api/clips",
	]);
});

test("node changes discard pending start responses and old-session actions never reach a new node", async () => {
	let finish!: (response: Response) => void;
	const calls: string[] = [];
	globalThis.fetch = fixtureFetch((url) => {
		calls.push(String(url));
		return new Promise<Response>((resolve) => {
			finish = resolve;
		});
	});
	const starting = useClipStore.getState().start(target);
	await Promise.resolve();
	await Promise.resolve();
	useClipStore.getState().resetRecording();
	finish(Response.json(context));
	await starting;
	expect(useClipStore.getState()).toMatchObject({
		status: "idle",
		clipId: null,
		sessionScope: null,
	});
	useClipStore.setState({
		status: "recording",
		clipId: "recording",
		sessionScope: JSON.stringify([target.url, target.token, null]),
	});
	expect(
		await useClipStore
			.getState()
			.stop({ url: "https://another.invalid", token: null })
	).toBeNull();
	expect(calls).toEqual(["https://fixture.invalid/api/clips/start"]);
	expect(useClipStore.getState()).toMatchObject({
		status: "idle",
		clipId: null,
	});
});

test("credential changes discard a finalized stop before attachment handoff", async () => {
	let finish!: (response: Response) => void;
	globalThis.fetch = fixtureFetch(
		() =>
			new Promise<Response>((resolve) => {
				finish = resolve;
			})
	);
	useClipStore.setState({
		status: "recording",
		clipId: "recording",
		sessionScope: JSON.stringify([target.url, target.token, null]),
	});
	const stopping = useClipStore.getState().stop(target);
	await Promise.resolve();
	await Promise.resolve();
	useClipStore.getState().resetRecording();
	finish(Response.json(context));
	expect(await stopping).toBeNull();
	expect(useClipStore.getState()).toMatchObject({
		status: "idle",
		lastContext: null,
		clipId: null,
	});
});
