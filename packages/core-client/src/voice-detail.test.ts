import { expect, test } from "bun:test";
import {
	parseTranscriptionDetail,
	transcribeAudio,
	transcribeAudioDetailed,
} from "./voice.ts";

test("measured word timestamps survive the detailed client without being fabricated", () => {
	const words = [
		{ startMs: 100, endMs: 420, text: " Hello " },
		{ startMs: 500, endMs: 800, text: "world" },
	];
	expect(
		parseTranscriptionDetail({ text: "Hello world", segments: [], words }).words
	).toEqual([
		{ startMs: 100, endMs: 420, text: "Hello" },
		{ startMs: 500, endMs: 800, text: "world" },
	]);
	expect(
		parseTranscriptionDetail({ text: "Hello world", segments: [] }).words
	).toBeUndefined();
	expect(() =>
		parseTranscriptionDetail({
			text: "Hello",
			words: [{ startMs: 500, endMs: 100, text: "Hello" }],
		})
	).toThrow();
});

test("detailed transcription preserves Core timestamps and caller identity", async () => {
	const calls: { url: string; headers: Headers; body: unknown }[] = [];
	const result = {
		text: " Hello world ",
		segments: [{ startMs: 250, endMs: 1250, text: " Hello world " }],
	};
	const target = {
		url: "https://node.example",
		token: "node-token",
		userJwt: "user-token",
		fetch: async (url: RequestInfo | URL, init?: RequestInit) => {
			calls.push({
				url: String(url),
				headers: new Headers(init?.headers),
				body: init?.body,
			});
			return Response.json(result);
		},
	};
	const detail = await transcribeAudioDetailed(
		target,
		new Blob(["audio"]),
		"voice.wav",
		"whisper"
	);
	expect(detail).toEqual({
		text: "Hello world",
		segments: [{ startMs: 250, endMs: 1250, text: "Hello world" }],
	});
	expect(calls[0]?.url).toBe(
		"https://node.example/api/voice/transcribe?engine=whisper"
	);
	expect(calls[0]?.headers.get("authorization")).toBe("Bearer node-token");
	expect(calls[0]?.headers.get("x-ryu-user-jwt")).toBe("user-token");
	expect(calls[0]?.headers.has("content-type")).toBe(false);
	expect(await transcribeAudio(target, new Blob(["audio"]))).toBe(
		"Hello world"
	);
	await transcribeAudioDetailed(
		target,
		new Blob(["audio"]),
		"voice.wav",
		"whisper",
		"auto"
	);
	// An explicit auto-detect is forwarded so it overrides a saved language.
	expect(calls.at(-1)?.url).toBe(
		"https://node.example/api/voice/transcribe?engine=whisper&language=auto"
	);
});
test("transcription parsing rejects malformed segment time and keeps text-only engines", () => {
	expect(parseTranscriptionDetail({ text: "Words" })).toEqual({
		text: "Words",
		segments: [],
	});
	expect(() =>
		parseTranscriptionDetail({
			text: "Words",
			segments: [{ startMs: 1000, endMs: 0, text: "Words" }],
		})
	).toThrow();
	expect(() =>
		parseTranscriptionDetail({
			text: "Words",
			segments: [{ startMs: Number.NaN, endMs: 1000, text: "Words" }],
		})
	).toThrow();
});

test("legacy plain-text transcription does not depend on optional segment metadata", async () => {
	const target = {
		url: "https://node.example",
		token: null,
		fetch: async () =>
			Response.json({
				text: "Usable text",
				segments: "malformed optional metadata",
			}),
	};
	expect(await transcribeAudio(target, new Blob(["audio"]))).toBe(
		"Usable text"
	);
	await expect(
		transcribeAudioDetailed(target, new Blob(["audio"]))
	).rejects.toThrow("Invalid transcription segments");
});
