import { describe, expect, test } from "bun:test";
import type {
	CoreTranscribeOptions,
	CoreTranscribeResult,
} from "../../shared/ipc.ts";
import {
	createIslandTranscribeAudio,
	type IslandTranscribeBridge,
	islandVoiceEngine,
} from "./island-transcribe.ts";

const WAV_DATA_URL = "data:audio/wav;base64,UklGRg==";

function fakeBridge(
	prefs: () => Promise<string | null>,
	result: CoreTranscribeResult
) {
	const calls: {
		bytes: number[];
		engine: string;
		options?: CoreTranscribeOptions;
	}[] = [];
	const bridge: IslandTranscribeBridge = {
		readVoicePrefs: prefs,
		transcribe: (audio, engine, options) => {
			calls.push({ bytes: [...new Uint8Array(audio)], engine, options });
			return Promise.resolve(result);
		},
	};
	return { bridge, calls };
}

describe("islandVoiceEngine", () => {
	test("uses the stored Voice Recognition engine", async () => {
		expect(
			await islandVoiceEngine({
				readVoicePrefs: () =>
					Promise.resolve(JSON.stringify({ engine: "whisper" })),
			})
		).toBe("whisper");
	});

	test("uses the Voice Recognition default when nothing is stored", async () => {
		expect(
			await islandVoiceEngine({ readVoicePrefs: () => Promise.resolve(null) })
		).toBe("parakeet");
	});

	test("leaves the engine to Core when the preference cannot be read", async () => {
		expect(
			await islandVoiceEngine({
				readVoicePrefs: () => Promise.reject(new Error("ipc closed")),
			})
		).toBe("");
	});
});

describe("createIslandTranscribeAudio", () => {
	test("sends decoded WAV bytes with the user's engine and returns trimmed text", async () => {
		const { bridge, calls } = fakeBridge(
			() => Promise.resolve(JSON.stringify({ engine: "gateway" })),
			{ available: true, text: "  hello  " }
		);
		const transcribe = createIslandTranscribeAudio(bridge);
		expect(await transcribe({ audio: WAV_DATA_URL })).toBe("hello");
		expect(calls).toEqual([
			{
				bytes: [82, 73, 70, 70],
				engine: "gateway",
				options: { filename: "recording.wav" },
			},
		]);
	});

	test("requests and returns timed segments for detailed callers", async () => {
		const detail = {
			text: "hello",
			segments: [{ startMs: 0, endMs: 400, text: "hello" }],
		};
		const { bridge, calls } = fakeBridge(() => Promise.resolve(null), {
			available: true,
			text: "hello",
			detail,
		});
		const transcribe = createIslandTranscribeAudio(bridge);
		expect(
			await transcribe({
				audio: WAV_DATA_URL,
				detailed: true,
				filename: "clip.wav",
			})
		).toEqual(detail);
		expect(calls[0]?.engine).toBe("parakeet");
		expect(calls[0]?.options).toEqual({ filename: "clip.wav", detailed: true });
	});

	test("rejects with Core's reason when transcription is unavailable", async () => {
		const { bridge } = fakeBridge(() => Promise.resolve(null), {
			available: false,
			reason: "core responded 503",
		});
		await expect(
			createIslandTranscribeAudio(bridge)({ audio: WAV_DATA_URL })
		).rejects.toThrow("core responded 503");
	});

	test("refuses non-data URLs instead of fetching them from the trusted host", async () => {
		const { bridge, calls } = fakeBridge(() => Promise.resolve(null), {
			available: true,
			text: "never",
		});
		await expect(
			createIslandTranscribeAudio(bridge)({
				audio: "https://example.invalid/a.wav",
			})
		).rejects.toThrow("data: URL");
		expect(calls).toEqual([]);
	});
});
