import { afterAll, beforeEach, expect, test } from "bun:test";
import {
	installTtsEngine,
	listSpeechProcessingEngines,
	listTtsEngines,
	listTtsModels,
	processSpeechText,
	speakText,
	transcribeAudio,
	transcribeAudioDetailed,
} from "./voice.ts";
import { ttsEnginesWireSchema } from "./voice-wire-contracts.ts";

const NativeResponse = Response;
const NativeHeaders = Headers;
let reply = NativeResponse.json({});
const requests: { headers: Headers; path: string; body: string }[] = [];
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		requests.push({
			headers: new NativeHeaders(request.headers),
			path: new URL(request.url).pathname + new URL(request.url).search,
			body: await request.text(),
		});
		return reply.clone();
	},
});
const target = {
	url: String(server.url).replace(/\/$/, ""),
	token: "voice-node",
	userJwt: "voice-user",
};
beforeEach(() => {
	requests.length = 0;
});
afterAll(() => {
	server.stop(true);
});
const engine = {
	default_voice: "voice",
	description: "Engine",
	display_name: "Engine",
	id: "engine",
	installed: false,
	languages: ["en"],
	loaded: false,
	sample_rate: 24_000,
	size_mb: 50,
	supports_cloning: true,
	voices: ["voice"],
	future: JSON.parse('{"__proto__":{"preserved":true}}'),
};
test("voice engine records use full SDK owners and preserve additive server metadata", async () => {
	const envelope = { data: [engine], future: { v: 2 } };
	expect(ttsEnginesWireSchema.parse(envelope)).toBe(envelope);
	expect(ttsEnginesWireSchema.parse(envelope).data?.[0]).toBe(engine);
	reply = NativeResponse.json(envelope);
	expect(JSON.stringify(await listTtsEngines(target))).toContain(
		'"__proto__":{"preserved":true}'
	);
	reply = NativeResponse.json({ data: null });
	expect(await listTtsEngines(target)).toEqual([]);
	reply = NativeResponse.json({ data: [{ id: "engine" }] });
	await expect(listTtsEngines(target)).rejects.toThrow();
	reply = NativeResponse.json({
		data: [
			{
				description: "Processing",
				display_name: "Processor",
				id: "s1-mini",
				installed: true,
				languages: [],
				loaded: true,
				model: "model",
				sidecar: "sidecar",
				size_mb: 1,
			},
		],
	});
	expect((await listSpeechProcessingEngines(target))[0]?.model).toBe("model");
	reply = NativeResponse.json({
		data: [
			{
				default: true,
				display_name: "Model",
				engine: "engine",
				engine_display_name: "Engine",
				hf_repo_id: "org/model",
				installed: false,
				languages: ["en"],
				model_name: "model",
				size_mb: 2,
			},
		],
	});
	expect((await listTtsModels(target))[0]?.hf_repo_id).toBe("org/model");
});
test("transcription retains text-only fallback and the actual timed-segment owner", async () => {
	const audio = new Blob(["audio"], { type: "audio/wav" });
	reply = NativeResponse.json({
		text: "  transcript  ",
		segments: [{ startMs: 0, endMs: 10, text: " segment " }],
		words: [{ startMs: 0, endMs: 5, text: " word " }],
	});
	expect(
		await transcribeAudioDetailed(target, audio, "voice.wav", " gateway ")
	).toEqual({
		text: "transcript",
		segments: [{ startMs: 0, endMs: 10, text: "segment" }],
		words: [{ startMs: 0, endMs: 5, text: "word" }],
	});
	expect(requests[0]?.path).toBe("/api/voice/transcribe?engine=gateway");
	await transcribeAudioDetailed(target, audio, "voice.wav", undefined, "pt-BR");
	expect(requests[1]?.path).toBe("/api/voice/transcribe?language=pt-BR");
	await transcribeAudio(target, audio, "voice.wav", "gateway", "auto");
	// An explicit auto-detect overrides a saved engine language in Core.
	expect(requests[2]?.path).toBe(
		"/api/voice/transcribe?engine=gateway&language=auto"
	);
	expect(requests[0]?.headers.get("Content-Type")).toContain(
		"multipart/form-data; boundary="
	);
	expect(requests[0]?.body).toContain('filename="voice.wav"');
	reply = NativeResponse.json({
		text: " transcript ",
		segments: "legacy-invalid",
	});
	expect(await transcribeAudio(target, audio)).toBe("transcript");
	await expect(transcribeAudioDetailed(target, audio)).rejects.toThrow(
		"Invalid transcription segments"
	);
	for (const raw of [null, {}, [], { text: 1 }]) {
		reply = NativeResponse.json(raw);
		expect(await transcribeAudio(target, audio)).toBe("");
	}
});
test("speech processing preserves optional request fields and engine install confirmation", async () => {
	reply = NativeResponse.json({ text: " polished " });
	expect(
		await processSpeechText(target, "raw", {
			engine: "engine",
			styling: "formal",
		})
	).toBe("polished");
	expect(requests[0]?.body).toBe(
		'{"text":"raw","engine":"engine","styling":"formal"}'
	);
	reply = NativeResponse.json({ text: null });
	expect(await processSpeechText(target, "raw")).toBe("");
	reply = NativeResponse.json({
		engine: "future-engine",
		installed: true,
		already_installed: null,
		future: 1,
	});
	expect(
		await installTtsEngine(target, "future-engine", {
			appId: "app",
			appPermission: "voice:generate",
		})
	).toEqual({
		already_installed: false,
		engine: "future-engine",
		installed: true,
	});
	expect(requests[2]?.headers.get("x-ryu-app-id")).toBe("app");
	expect(requests[2]?.headers.get("x-ryu-app-permission")).toBe(
		"voice:generate"
	);
	reply = NativeResponse.json({ engine: "other", installed: true });
	await expect(installTtsEngine(target, "engine")).rejects.toThrow(
		"Core did not confirm the speech engine install."
	);
});
test("voice errors keep status fallback and native binary speech replies", async () => {
	reply = NativeResponse.json(
		{ error: "denied", detail: "app permission" },
		{ status: 403 }
	);
	await expect(installTtsEngine(target, "engine")).rejects.toThrow(
		"denied: app permission"
	);
	reply = new NativeResponse("plain text", { status: 503 });
	await expect(transcribeAudio(target, new Blob(["audio"]))).rejects.toThrow(
		"transcribe failed: 503"
	);
	reply = NativeResponse.json({ error: "" }, { status: 403 });
	await expect(processSpeechText(target, "raw")).rejects.toThrow(
		"Speech Processing failed: 403"
	);
	reply = new NativeResponse(new Uint8Array([82, 73, 70, 70]), {
		headers: { "Content-Type": "audio/wav" },
	});
	const spoken = await speakText(target, "Speak", {
		engine: "engine",
		speed: 0,
		appId: "app",
		appPermission: "voice:generate",
		requestId: "request",
	});
	expect(Array.from(new Uint8Array(await spoken.arrayBuffer()))).toEqual([
		82, 73, 70, 70,
	]);
	expect(requests[3]?.headers.get("x-ryu-app-id")).toBe("app");
	expect(requests[3]?.body).toBe(
		'{"text":"Speak","request_id":"request","engine":"engine","speed":0}'
	);
});
