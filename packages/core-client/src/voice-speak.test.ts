import { expect, test } from "bun:test";
import { listTtsEngines, speakText, speechAudioMime } from "./voice.ts";

function targetReturning(response: () => Response) {
	const calls: { url: string; body: unknown }[] = [];
	const target = {
		url: "https://node.example",
		token: "node-token",
		fetch: (url: RequestInfo | URL, init?: RequestInit) => {
			calls.push({
				url: String(url),
				body: init?.body ? JSON.parse(String(init.body)) : undefined,
			});
			return Promise.resolve(response());
		},
	};
	return { calls, target };
}

test("speakText forwards every studio option in snake_case", async () => {
	const { calls, target } = targetReturning(
		() =>
			new Response(new Uint8Array([1, 2, 3]), {
				headers: { "content-type": "audio/mpeg" },
			})
	);
	const blob = await speakText(target, "Hello", {
		engine: "kokoro",
		seed: 42,
		instruct: "calm",
		referenceText: "sample words",
		effects: [{ type: "gain", params: { db: -2 } }],
		normalize: "podcast",
		format: "mp3",
	});
	expect(blob.type).toBe("audio/mpeg");
	expect(calls[0]?.url).toBe("https://node.example/api/voice/speak");
	expect(calls[0]?.body).toEqual({
		text: "Hello",
		engine: "kokoro",
		seed: 42,
		instruct: "calm",
		reference_text: "sample words",
		effects: [{ type: "gain", params: { db: -2 } }],
		normalize: "podcast",
		format: "mp3",
	});
});

test("speakText keeps legacy WAV responses and refuses unknown types", async () => {
	const legacy = targetReturning(() => new Response(new Uint8Array([1])));
	expect((await speakText(legacy.target, "Hi")).type).toBe("audio/wav");

	const html = targetReturning(
		() => new Response("<html>", { headers: { "content-type": "text/html" } })
	);
	await expect(speakText(html.target, "Hi")).rejects.toThrow(
		"unsupported audio type"
	);
});

test("speech MIME normalization covers the allowlisted containers", () => {
	expect(speechAudioMime(null)).toBe("audio/wav");
	expect(speechAudioMime("audio/x-wav")).toBe("audio/wav");
	expect(speechAudioMime("audio/ogg; codecs=vorbis")).toBe("audio/ogg");
	expect(speechAudioMime("audio/x-flac")).toBe("audio/flac");
	expect(speechAudioMime("audio/mp3")).toBe("audio/mpeg");
	expect(speechAudioMime("application/json")).toBeNull();
});

test("speech MIME normalization accepts every type Core's Gateway path serves", () => {
	// Mirrors `gateway_audio_mime` in apps/core/src/server/voice.rs.
	for (const mime of [
		"audio/mpeg",
		"audio/wav",
		"audio/ogg",
		"audio/flac",
		"audio/aac",
		"audio/pcm",
	]) {
		expect(speechAudioMime(mime)).toBe(mime);
	}
});

test("engine rows keep optional capability fields and accept old rows", async () => {
	const legacyRow = {
		default_voice: "",
		description: "",
		display_name: "OuteTTS",
		id: "outetts",
		installed: true,
		languages: ["en"],
		loaded: false,
		sample_rate: 24_000,
		size_mb: 0,
		supports_cloning: false,
		voices: [],
	};
	const studioRow = {
		...legacyRow,
		id: "qwen3",
		supports_instruct: true,
		supports_design: true,
		supports_seed: true,
		native_speed: false,
		paralinguistic_tags: ["laugh"],
		license: "Apache-2.0",
		commercial_use: true,
	};
	const { target } = targetReturning(() =>
		Response.json({ data: [legacyRow, studioRow] })
	);
	const engines = await listTtsEngines(target);
	expect(engines[0]?.supports_instruct).toBeUndefined();
	expect(engines[1]).toEqual(studioRow);
});
