import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { dispatchRpc, type HostServices } from "@ryu/app-host/rpc";
import { createCompanionMediaServices } from "./media-host-services.ts";

// The actual Companion media services, driven through the bridge dispatcher
// against a recording HTTP server standing in for Core. Proves the new bridge
// fields reach Core's routes unchanged, and that a refusal or a failed job
// reaches the app as an error rather than an empty result.

interface RecordedRequest {
	appId: string | null;
	body: unknown;
	method: string;
	path: string;
}

const PNG = "data:image/png;base64,iVBORw0KGgo=";
const JPEG = "data:image/jpeg;base64,/9j/4AAQ";
const MP4 = "data:video/mp4;base64,AAAAIGZ0eXA=";
const WAV = "data:audio/wav;base64,UklGRiQAAABXQVZF";

const requests: RecordedRequest[] = [];
let audioScenario: "ok" | "refused" | "failed" | "empty" = "ok";
let audioPolls = 0;

function audioReply(path: string): Response {
	if (path.endsWith("/api/audio/generate")) {
		if (audioScenario === "refused") {
			return Response.json(
				{
					error:
						"audio generation needs a cloud provider (fal or replicate); there is no local music or sound-effect engine",
				},
				{ status: 400 }
			);
		}
		return Response.json({ id: "job-a1", status: "queued" });
	}
	audioPolls += 1;
	if (audioScenario === "failed") {
		return Response.json({
			id: "job-a1",
			status: "failed",
			error: "provider quota exhausted",
		});
	}
	if (audioScenario === "empty") {
		return Response.json({ id: "job-a1", status: "succeeded", data: [] });
	}
	return Response.json({
		id: "job-a1",
		status: audioPolls === 1 ? "running" : "succeeded",
		data: [{ url: WAV }],
	});
}

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const path = new URL(request.url).pathname;
		requests.push({
			appId: request.headers.get("x-ryu-app-id"),
			body: request.method === "GET" ? null : await request.json(),
			method: request.method,
			path,
		});
		if (path.endsWith("/api/video/generate")) {
			return Response.json({ data: [{ url: MP4, mime_type: "video/mp4" }] });
		}
		if (path.endsWith("/api/images/generate")) {
			return Response.json({ data: [{ b64_json: "iVBORw0KGgo=" }] });
		}
		if (path.includes("/api/audio/")) {
			return audioReply(path);
		}
		if (path.endsWith("/host")) {
			return Response.json({ result: "two cats on a sofa" });
		}
		return new Response("not found", { status: 404 });
	},
});
afterAll(() => server.stop(true));
beforeEach(() => {
	requests.length = 0;
	audioScenario = "ok";
	audioPolls = 0;
});

const services: HostServices = {
	listAgents: async () => {
		throw new Error("Unexpected listAgents call");
	},
	registerRoute: async () => {
		throw new Error("Unexpected registerRoute call");
	},
	...createCompanionMediaServices({
		appId: "@ryu/example",
		appPermission: "example.generate",
		inline: (url) => Promise.resolve(url),
		pluginId: "@ryu/example",
		pollIntervalMs: 5,
		target: {
			url: `${server.url.toString().replace(/\/$/, "")}/node`,
			token: "fixture-node-admission",
		},
	}),
};
const MEDIA = new Set(["media.generate"] as const);

describe("Companion media services reach Core with every bridge field", () => {
	test("media.video forwards frames, clip, audio, duration and provider_input", async () => {
		const providerInput = {
			first_frame_url: "$input_images.0",
			last_frame_url: "$input_images.1",
			video_url: "$input_video",
			audio_url: "$input_audio",
			num_frames: "$duration_s",
		};
		const clips = await dispatchRpc(
			"media.video",
			[
				{
					prompt: "bridge the cut",
					provider: "fal",
					model: "fal-ai/example-flf2v",
					request_id: "gen-1",
					input_images: [PNG, JPEG],
					input_video: MP4,
					input_audio: WAV,
					duration_s: 4,
					provider_input: providerInput,
				},
			],
			MEDIA,
			services
		);
		expect(clips).toEqual([{ url: MP4, mediaType: "video/mp4" }]);
		expect(requests).toEqual([
			{
				appId: "@ryu/example",
				method: "POST",
				path: "/node/api/video/generate",
				body: {
					prompt: "bridge the cut",
					provider: "fal",
					model: "fal-ai/example-flf2v",
					request_id: "gen-1",
					input_images: [PNG, JPEG],
					input_video: MP4,
					input_audio: WAV,
					duration_s: 4,
					provider_input: providerInput,
				},
			},
		]);
	});

	test("a routing-key override never leaves the host", async () => {
		await expect(
			dispatchRpc(
				"media.video",
				[{ prompt: "p", provider_input: { model: "other" } }],
				MEDIA,
				services
			)
		).rejects.toMatchObject({ code: "invalid_args" });
		expect(requests).toEqual([]);
	});

	test("media.image forwards provider_input", async () => {
		await dispatchRpc(
			"media.image",
			[
				{
					prompt: "a cat",
					provider: "fal",
					model: "fal-ai/example",
					provider_input: { seed: 7 },
				},
			],
			MEDIA,
			services
		);
		expect(requests[0]?.path).toBe("/node/api/images/generate");
		expect(requests[0]?.body).toMatchObject({
			prompt: "a cat",
			provider: "fal",
			model: "fal-ai/example",
			provider_input: { seed: 7 },
		});
	});

	test("media.audio submits, polls the job and returns the inlined file", async () => {
		const clips = await dispatchRpc(
			"media.audio",
			[
				{
					prompt: "door slam",
					kind: "sfx",
					duration_s: 2,
					provider: "fal",
					model: "fal-ai/example-audio",
					provider_input: { seconds_total: "$duration_s" },
					request_id: "sfx-1",
				},
			],
			MEDIA,
			services
		);
		expect(clips).toEqual([{ url: WAV, mediaType: "audio/wav" }]);
		expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
			"POST /node/api/audio/generate",
			"GET /node/api/audio/jobs/job-a1",
			"GET /node/api/audio/jobs/job-a1",
		]);
		expect(requests[0]?.body).toEqual({
			kind: "sfx",
			model: "fal-ai/example-audio",
			prompt: "door slam",
			provider: "fal",
			duration_s: 2,
			provider_input: { seconds_total: "$duration_s" },
			request_id: "sfx-1",
		});
	}, 15_000);

	test("media.audio surfaces Core's refusal, a failed job and an empty result", async () => {
		const call = () =>
			dispatchRpc(
				"media.audio",
				[{ prompt: "rain", kind: "sfx", provider: "fal", model: "m" }],
				MEDIA,
				services
			);
		audioScenario = "refused";
		await expect(call()).rejects.toThrow(
			"no local music or sound-effect engine"
		);
		audioScenario = "failed";
		await expect(call()).rejects.toThrow("provider quota exhausted");
		audioScenario = "empty";
		await expect(call()).rejects.toThrow("without an audio file");
	});

	test("model.complete forwards vision images to the governed bridge", async () => {
		const reply = await dispatchRpc(
			"model.complete",
			[{ prompt: "describe", images: [PNG, JPEG] }],
			new Set(["model.complete"] as const),
			services
		);
		expect(reply).toBe("two cats on a sofa");
		expect(requests).toEqual([
			{
				appId: null,
				method: "POST",
				path: "/node/api/plugins/%40ryu%2Fexample/host",
				body: {
					method: "model.complete",
					args: { prompt: "describe", images: [PNG, JPEG] },
				},
			},
		]);
	});

	test("host.capabilities advertises the forwarded inputs", async () => {
		await expect(
			dispatchRpc("host.capabilities", [], new Set(), services)
		).resolves.toMatchObject({
			bridge: {
				"media.audio": true,
				"media.video.inputs": true,
				"model.vision": true,
			},
		});
	});
});
