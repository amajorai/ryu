import { afterAll, describe, expect, test } from "bun:test";
import { generateVideo, pollVideoJob } from "./video.ts";
import { videoClipsSchema } from "./video-wire-contracts.ts";

let scenario = "local";
let polls = 0;
let submitted = "";
let polledPath = "";
const server = Bun.serve({
	port: 0,
	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname.endsWith("/generate")) {
			submitted = await request.text();
			if (scenario === "failure") {
				return Response.json({ error: 42 }, { status: 503 });
			}
			if (scenario === "empty-error") {
				return Response.json({ error: null }, { status: 503 });
			}
			if (scenario === "cloud" || scenario === "job-failure") {
				return Response.json({
					id: "job/one",
					status: "queued",
					future: { metadata: true },
				});
			}
			return Response.json({
				data: [
					"encoded",
					{ url: "https://video.example/clip", mime_type: "video/webm" },
					null,
					{ video: "legacy" },
				],
			});
		}
		polledPath = url.pathname;
		polls += 1;
		if (scenario === "job-failure") {
			return Response.json({ id: "job/one", status: "failed", error: 42 });
		}
		return Response.json({
			id: "job/one",
			status: polls === 1 ? "running" : "completed",
			videos: ["https://video.example/cloud"],
			future: { metadata: true },
		});
	},
});
const target = { token: null, url: server.url.origin };
afterAll(() => server.stop(true));
describe("Video JSON and media projection", () => {
	test("keeps synchronous legacy encodings and MIME priority", async () => {
		const clips = await generateVideo(target, "prompt", {
			requestId: "request",
		});
		expect(clips).toEqual([
			{ url: "data:video/mp4;base64,encoded", mediaType: "video/mp4" },
			{ url: "https://video.example/clip", mediaType: "video/webm" },
			{ url: "data:video/mp4;base64,legacy", mediaType: "video/mp4" },
		]);
		expect(JSON.parse(submitted)).toEqual({
			prompt: "prompt",
			request_id: "request",
		});
	});
	test("keeps empty preferred arrays, empty URLs, and empty base64 precedence", () => {
		expect(videoClipsSchema.parse({ data: [], videos: ["encoded"] })).toEqual(
			[]
		);
		expect(
			videoClipsSchema.parse([
				{ url: "", mediaType: "" },
				{ b64_json: "", video: "ignored" },
				"",
			])
		).toEqual([
			{ url: "", mediaType: "" },
			{ url: "data:video/mp4;base64,", mediaType: "video/mp4" },
		]);
		expect(videoClipsSchema.parse("bare-root-string")).toEqual([]);
	});
	test("polls the encoded job path and keeps future protocol metadata", async () => {
		scenario = "cloud";
		polls = 0;
		try {
			expect(
				await generateVideo(target, "prompt", {
					provider: "replicate",
					model: "model",
					pollIntervalMs: 0,
					timeoutMs: 2000,
				})
			).toEqual([
				{ url: "https://video.example/cloud", mediaType: "video/mp4" },
			]);
			expect(polledPath).toBe("/api/video/jobs/job%2Fone");
			expect(polls).toBe(2);
			expect(await pollVideoJob(target, "job/one")).toMatchObject({
				future: { metadata: true },
			});
		} finally {
			scenario = "local";
		}
	});
	test("preserves HTTP and failed-job error coercion", async () => {
		try {
			scenario = "failure";
			await expect(generateVideo(target, "prompt")).rejects.toThrow("42");
			scenario = "empty-error";
			await expect(generateVideo(target, "prompt")).rejects.toThrow(
				"video generation failed: 503"
			);
			scenario = "job-failure";
			await expect(
				generateVideo(target, "prompt", {
					provider: "replicate",
					pollIntervalMs: 0,
					timeoutMs: 2000,
				})
			).rejects.toThrow("42");
		} finally {
			scenario = "local";
		}
	});
});
