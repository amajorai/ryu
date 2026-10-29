import { describe, expect, test } from "bun:test";
import {
	companionVoiceEngine,
	createCompanionTranscribeAudio,
} from "./companion-voice-engine.ts";

const WAV_DATA_URL = "data:audio/wav;base64,UklGRg==";

describe("companionVoiceEngine", () => {
	test("returns the user's Voice Recognition engine", async () => {
		expect(
			await companionVoiceEngine(() => Promise.resolve({ engine: "audiocpp" }))
		).toBe("audiocpp");
	});

	test("falls back to Core's default when preferences are unavailable", async () => {
		expect(
			await companionVoiceEngine(() => Promise.reject(new Error("offline")))
		).toBeUndefined();
		expect(
			await companionVoiceEngine(() => Promise.resolve({ engine: "  " }))
		).toBeUndefined();
	});
});

describe("createCompanionTranscribeAudio", () => {
	function fake(engine: string) {
		const calls: {
			kind: string;
			filename: string;
			engine?: string;
			size: number;
		}[] = [];
		const transcribe = createCompanionTranscribeAudio({
			readPrefs: () => Promise.resolve({ engine }),
			transcribe: (blob, filename, chosen) => {
				calls.push({ kind: "text", filename, engine: chosen, size: blob.size });
				return Promise.resolve("hello");
			},
			transcribeDetailed: (blob, filename, chosen) => {
				calls.push({
					kind: "detailed",
					filename,
					engine: chosen,
					size: blob.size,
				});
				return Promise.resolve({ text: "hello", segments: [] });
			},
		});
		return { calls, transcribe };
	}

	test("passes the user's engine to plain and detailed transcription", async () => {
		const { calls, transcribe } = fake("whisper");
		expect(await transcribe({ audio: WAV_DATA_URL })).toBe("hello");
		expect(
			await transcribe({
				audio: WAV_DATA_URL,
				detailed: true,
				filename: "clip.wav",
			})
		).toEqual({ text: "hello", segments: [] });
		expect(calls).toEqual([
			{ kind: "text", filename: "recording.wav", engine: "whisper", size: 4 },
			{ kind: "detailed", filename: "clip.wav", engine: "whisper", size: 4 },
		]);
	});

	test("refuses non-data URLs without fetching them", async () => {
		const { calls, transcribe } = fake("parakeet");
		await expect(
			transcribe({ audio: "http://127.0.0.1:1/secret" })
		).rejects.toThrow("data: URL");
		expect(calls).toEqual([]);
	});
});
