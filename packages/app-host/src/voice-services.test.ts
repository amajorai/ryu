import { afterAll, expect, test } from "bun:test";
import {
	capabilitiesFromGrants,
	dispatchRpc,
	type HostServices,
} from "./rpc.ts";
import {
	buildVoiceServices,
	VOICE_AUDIO_BYTE_LIMIT,
	voiceAudioDataUrl,
} from "./voice-services.ts";

test("voice dispatch retains host ownership, identity and clone inputs, and rejects unconfirmed installs", async () => {
	const calls: { path: string; headers: Headers; body: unknown }[] = [];
	let rejectInstall = true;
	const voice = buildVoiceServices(
		{
			url: "https://native-node.test",
			token: "node-secret",
			userJwt: "user-secret",
			fetch: async (input, init) => {
				const path = new URL(String(input)).pathname;
				calls.push({
					path,
					headers: new Headers(init?.headers),
					body: init?.body ? JSON.parse(String(init.body)) : null,
				});
				if (path.endsWith("/install")) {
					return Response.json({
						engine: "outetts",
						installed: !rejectInstall,
					});
				}
				if (path.endsWith("tts-engines")) {
					return Response.json({ data: [] });
				}
				return new Response(new Uint8Array([82, 73, 70, 70]), {
					headers: { "Content-Type": "audio/wav" },
				});
			},
		},
		"@ryu/voice",
		"voice.studio.generate",
		async (blob) => `audio:${blob.size}`
	);
	const services: HostServices = {
		...voice,
		listAgents: async () => [],
		registerRoute: async (claim) => ({ path: claim.path }),
	};
	const grants = capabilitiesFromGrants([
		"media:generate",
		"voice:models:manage",
		"registry:read",
	]);
	await expect(
		dispatchRpc("media.tts", [{ text: "hello" }], new Set(), services)
	).rejects.toThrow();
	expect(calls).toHaveLength(0);
	await expect(
		dispatchRpc(
			"media.tts",
			[
				{
					text: "hello",
					engine: "outetts",
					request_id: "request-1",
					reference_audio_data_url: "data:audio/wav;base64,UklGRg==",
				},
			],
			grants,
			services
		)
	).resolves.toBe("audio:4");
	expect(calls[0]?.body).toMatchObject({
		text: "hello",
		engine: "outetts",
		request_id: "request-1",
		reference_audio_data_url: "data:audio/wav;base64,UklGRg==",
	});
	expect(calls[0]?.headers.get("authorization")).toBe("Bearer node-secret");
	expect(calls[0]?.headers.get("x-ryu-user-jwt")).toBe("user-secret");
	expect(calls[0]?.headers.get("x-ryu-app-id")).toBe("@ryu/voice");
	expect(calls[0]?.headers.get("x-ryu-app-permission")).toBe(
		"voice.studio.generate"
	);
	await expect(voice.installTtsEngine?.({ engine: "outetts" })).rejects.toThrow(
		"did not confirm"
	);
	rejectInstall = false;
	await expect(
		voice.installTtsEngine?.({ engine: "outetts" })
	).resolves.toEqual({
		engine: "outetts",
		installed: true,
		already_installed: false,
	});
	expect(calls.at(-1)?.headers.get("x-ryu-app-permission")).toBe(
		"voice.models.manage"
	);
	await expect(voice.listTtsEngines?.()).resolves.toEqual([]);
});

test("audio conversion refuses oversized speech before allocating a reader", async () => {
	await expect(
		voiceAudioDataUrl(new Blob([new Uint8Array(VOICE_AUDIO_BYTE_LIMIT + 1)]))
	).rejects.toThrow("size limit");
});

/** Bun has no FileReader; a minimal data-URL reader keeps the host encoder real. */
class DataUrlReaderShim {
	onerror: (() => void) | null = null;
	onload: (() => void) | null = null;
	result: string | null = null;
	readAsDataURL(blob: Blob) {
		blob
			.arrayBuffer()
			.then((bytes) => {
				this.result = `data:${blob.type};base64,${Buffer.from(bytes).toString("base64")}`;
				this.onload?.();
			})
			.catch(() => this.onerror?.());
	}
}
if (typeof globalThis.FileReader === "undefined") {
	Object.defineProperty(globalThis, "FileReader", {
		value: DataUrlReaderShim,
		configurable: true,
	});
	afterAll(() => {
		Reflect.deleteProperty(globalThis, "FileReader");
	});
}

test("studio speak fields cross the bridge and the data URL keeps the served MIME", async () => {
	const bodies: unknown[] = [];
	const voice = buildVoiceServices(
		{
			url: "https://native-node.test",
			token: "node-secret",
			fetch: (_input, init) => {
				bodies.push(init?.body ? JSON.parse(String(init.body)) : null);
				return Promise.resolve(
					new Response(new Uint8Array([73, 68, 51]), {
						headers: { "Content-Type": "audio/mpeg" },
					})
				);
			},
		},
		"@ryu/voice",
		"voice.studio.generate"
	);
	const services: HostServices = {
		...voice,
		listAgents: async () => [],
		registerRoute: async (claim) => ({ path: claim.path }),
	};
	const url = await dispatchRpc(
		"media.tts",
		[
			{
				text: "hello",
				engine: "kokoro",
				seed: 9,
				instruct: "bright",
				reference_text: "sample",
				effects: [{ type: "echo", params: { delay_ms: 120 } }],
				normalize: "peak",
				format: "mp3",
				smuggled: "dropped",
			},
		],
		capabilitiesFromGrants(["media:generate"]),
		services
	);
	expect(String(url).startsWith("data:audio/mpeg;base64,")).toBe(true);
	expect(bodies[0]).toEqual({
		text: "hello",
		engine: "kokoro",
		seed: 9,
		instruct: "bright",
		reference_text: "sample",
		effects: [{ type: "echo", params: { delay_ms: 120 } }],
		normalize: "peak",
		format: "mp3",
	});
});

test("audio conversion types legacy blobs as WAV and refuses non-audio", async () => {
	await expect(
		voiceAudioDataUrl(new Blob([new Uint8Array([1])]))
	).resolves.toMatch(/^data:audio\/wav;base64,/u);
	await expect(
		voiceAudioDataUrl(new Blob(["<html>"], { type: "text/html" }))
	).rejects.toThrow("unsupported type");
});
