// Unit coverage for the pure RPC ARGUMENT VALIDATORS in rpc.ts that the existing
// suites (app-bridge / widget-mount / adversarial / rpc) don't already exercise.
// Each validator is the narrow gate a host method's args pass through before the
// service runs; a hole here widens the dispatch surface or forwards a malformed
// shape to Core. These assert the accept/reject boundary — notably URL-scheme
// vetting, numeric-bound rejection (NaN/Infinity/negative), and the
// Record<string,string>-only input maps — DOM-free, no port needed.

import { describe, expect, test } from "bun:test";
import {
	asComposioArg,
	asDisplayModeArg,
	asMediaAudioArg,
	asMediaImageArg,
	asMediaTtsArg,
	asMediaTtsEngineInstallArg,
	asMediaVideoArg,
	asModelCompleteArg,
	asOpenExternalArg,
	asPromptArg,
	asRouteClaim,
	asShellOpenTabArg,
	asWorkflowResumeArg,
	asWorkflowRunArg,
	CodedRpcError,
	capabilitiesFromGrants,
	dispatchRpc,
	MAX_MEDIA_IMAGE_INPUT_CHARS,
	MAX_MEDIA_INPUT_CHARS,
	MAX_MODEL_COMPLETE_IMAGE_CHARS,
	toRpcError,
} from "./rpc.ts";

describe("asOpenExternalArg — scheme vetting", () => {
	test("accepts http(s) from a bare string, { href }, and { url }", () => {
		expect(asOpenExternalArg("https://example.com/x")).toEqual({
			href: "https://example.com/x",
		});
		expect(asOpenExternalArg({ href: "http://example.com/" })).toEqual({
			href: "http://example.com/",
		});
		// `url` is the openai-shim alias for `href`.
		expect(asOpenExternalArg({ url: "https://a.test/p" })).toEqual({
			href: "https://a.test/p",
		});
	});

	test("rejects dangerous non-http(s) schemes", () => {
		for (const bad of [
			"javascript:alert(1)",
			"file:///etc/passwd",
			"data:text/html,<script>1</script>",
			"ftp://host/f",
			"chrome://settings",
		]) {
			expect(asOpenExternalArg(bad)).toBeNull();
		}
	});

	test("rejects malformed URLs, empty strings, and non-string shapes", () => {
		expect(asOpenExternalArg("not a url")).toBeNull();
		expect(asOpenExternalArg("")).toBeNull();
		expect(asOpenExternalArg({ href: "" })).toBeNull();
		expect(asOpenExternalArg({ href: 42 })).toBeNull();
		expect(asOpenExternalArg(null)).toBeNull();
		expect(asOpenExternalArg({})).toBeNull();
	});
});

describe("asDisplayModeArg", () => {
	test("accepts a bare mode string or a { mode } object", () => {
		expect(asDisplayModeArg("inline")).toBe("inline");
		expect(asDisplayModeArg("fullscreen")).toBe("fullscreen");
		expect(asDisplayModeArg({ mode: "pip" })).toBe("pip");
	});

	test("rejects unknown modes and non-mode shapes", () => {
		expect(asDisplayModeArg("modal")).toBeNull();
		expect(asDisplayModeArg({ mode: "sidebar" })).toBeNull();
		expect(asDisplayModeArg({})).toBeNull();
		expect(asDisplayModeArg(null)).toBeNull();
		expect(asDisplayModeArg(3)).toBeNull();
	});
});

describe("asShellOpenTabArg", () => {
	test("requires a non-empty path and copies only well-typed options", () => {
		expect(
			asShellOpenTabArg({
				path: "/chat",
				title: "Chat",
				conversationId: "c1",
				forceNew: true,
				initialPrompt: "hi",
			})
		).toEqual({
			path: "/chat",
			title: "Chat",
			conversationId: "c1",
			forceNew: true,
			initialPrompt: "hi",
		});
	});

	test("drops mistyped optionals rather than failing the whole arg", () => {
		expect(
			asShellOpenTabArg({ path: "/chat", title: 5, forceNew: "yes" })
		).toEqual({ path: "/chat" });
	});

	test("rejects a missing / empty path or non-object", () => {
		expect(asShellOpenTabArg({ path: "" })).toBeNull();
		expect(asShellOpenTabArg({ title: "no path" })).toBeNull();
		expect(asShellOpenTabArg(null)).toBeNull();
		expect(asShellOpenTabArg("/chat")).toBeNull();
	});
});

describe("asMediaImageArg — numeric bound on count", () => {
	test("accepts a non-negative finite count and optional strings", () => {
		expect(
			asMediaImageArg({
				prompt: "cat",
				count: 4,
				size: "1024",
				request_id: "generation-1",
			})
		).toEqual({
			prompt: "cat",
			count: 4,
			size: "1024",
			request_id: "generation-1",
		});
		// count is optional; zero is allowed (>= 0).
		expect(asMediaImageArg({ prompt: "cat", count: 0 })).toEqual({
			prompt: "cat",
			count: 0,
		});
		expect(asMediaImageArg({ prompt: "cat" })).toEqual({ prompt: "cat" });
	});

	test("rejects a negative, NaN, or Infinite count", () => {
		expect(asMediaImageArg({ prompt: "cat", count: -1 })).toBeNull();
		expect(asMediaImageArg({ prompt: "cat", count: Number.NaN })).toBeNull();
		expect(
			asMediaImageArg({ prompt: "cat", count: Number.POSITIVE_INFINITY })
		).toBeNull();
	});

	test("rejects an empty prompt or a mistyped optional string", () => {
		expect(asMediaImageArg({ prompt: "" })).toBeNull();
		expect(asMediaImageArg({ prompt: "cat", size: 512 })).toBeNull();
		expect(asMediaImageArg(null)).toBeNull();
	});
});

describe("asMediaTtsArg — numeric bound on speed", () => {
	test("accepts text with optional engine/voice/language/speed", () => {
		expect(
			asMediaTtsArg({
				text: "hello",
				engine: "e",
				voice: "v",
				speed: 1.5,
				request_id: "generation-2",
			})
		).toEqual({
			text: "hello",
			engine: "e",
			voice: "v",
			speed: 1.5,
			request_id: "generation-2",
		});
	});

	test("accepts a bounded WAV data URL for an authorized clone request", () => {
		expect(
			asMediaTtsArg({
				text: "Hello there.",
				reference_audio_data_url: "data:audio/wav;base64,UklGRg==",
			})
		).toEqual({
			text: "Hello there.",
			reference_audio_data_url: "data:audio/wav;base64,UklGRg==",
		});
		expect(
			asMediaTtsArg({
				text: "Hello there.",
				reference_audio_data_url: "https://example.com/ref.wav",
			})
		).toBeNull();
		expect(
			asMediaTtsArg({
				text: "Hello there.",
				reference_audio_data_url: `data:audio/wav;base64,${"A".repeat(700_001)}`,
			})
		).toBeNull();
	});

	test("rejects empty text and out-of-range speed", () => {
		expect(asMediaTtsArg({ text: "" })).toBeNull();
		expect(asMediaTtsArg({ text: "hi", speed: -0.5 })).toBeNull();
		expect(asMediaTtsArg({ text: "hi", speed: Number.NaN })).toBeNull();
		expect(asMediaTtsArg({ text: "hi", voice: 9 })).toBeNull();
	});
});

describe("asMediaTtsArg — studio speak fields", () => {
	test("copies only declared keys, including nested effect fields", () => {
		expect(
			asMediaTtsArg({
				text: "hi",
				seed: 4_294_967_295,
				instruct: "slow and warm",
				reference_text: "sample transcript",
				effects: [
					{ type: "gain", params: { gain_db: -3 } },
					{ type: "pitch_shift" },
				],
				normalize: "acx",
				format: "flac",
				extra: "dropped",
			})
		).toEqual({
			text: "hi",
			seed: 4_294_967_295,
			instruct: "slow and warm",
			reference_text: "sample transcript",
			effects: [
				{ type: "gain", params: { gain_db: -3 } },
				{ type: "pitch_shift" },
			],
			normalize: "acx",
			format: "flac",
		});
	});

	test("rejects out-of-bounds and unknown studio values", () => {
		const effect = { type: "gain" };
		for (const bad of [
			{ seed: -1 },
			{ seed: 4_294_967_296 },
			{ seed: 1.5 },
			{ instruct: "a".repeat(501) },
			{ reference_text: "a".repeat(1001) },
			{ effects: new Array(13).fill(effect) },
			{ effects: [{ type: "speed" }] },
			{
				effects: [
					{ type: "gain", params: { gain_db: Number.POSITIVE_INFINITY } },
				],
			},
			{ effects: [{ type: "gain", params: { "Bad Key": 1 } }] },
			{ effects: [{ type: "gain", script: "x" }] },
			{ normalize: "loud" },
			{ format: "aac" },
		]) {
			expect(asMediaTtsArg({ text: "hi", ...bad })).toBeNull();
		}
		expect(asMediaTtsArg({ text: "a".repeat(50_001) })).toBeNull();
		expect(asMediaTtsArg({ text: "a".repeat(50_000) })).toEqual({
			text: "a".repeat(50_000),
		});
		expect(asMediaTtsArg({ text: "hi", instruct: "a".repeat(500) })).toEqual({
			text: "hi",
			instruct: "a".repeat(500),
		});
	});
});

describe("asMediaTtsEngineInstallArg", () => {
	test("accepts one bounded registry id and rejects commands or malformed input", () => {
		expect(asMediaTtsEngineInstallArg({ engine: "pocket" })).toEqual({
			engine: "pocket",
		});
		expect(asMediaTtsEngineInstallArg({ engine: "../pip" })).toBeNull();
		expect(asMediaTtsEngineInstallArg({ engine: 42 })).toBeNull();
	});
});

describe("asMediaVideoArg — request correlation", () => {
	test("preserves a bounded request id while rejecting non-string ids", () => {
		expect(
			asMediaVideoArg({ prompt: "a slow dolly", request_id: "generation-3" })
		).toEqual({ prompt: "a slow dolly", request_id: "generation-3" });
		expect(
			asMediaVideoArg({ prompt: "a slow dolly", request_id: 3 })
		).toBeNull();
	});
});

const PNG = "data:image/png;base64,iVBORw0KGgo=";
const JPEG = "data:image/jpeg;base64,/9j/4AAQ";
const MP4 = "data:video/mp4;base64,AAAAIGZ0eXA=";
const WAV = "data:audio/wav;base64,UklGRiQAAABXQVZF";
/** A data URI of `family/subtype` whose total length is exactly `chars`. */
function dataUriOfLength(prefix: string, chars: number): string {
	return `${prefix}${"A".repeat(chars - prefix.length)}`;
}

describe("asMediaVideoArg — reference inputs", () => {
	test("accepts first/last frames, a clip, an audio track and provider_input", () => {
		const input = {
			prompt: "match the cut",
			provider: "fal",
			model: "fal-ai/example-flf2v",
			input_images: [PNG, JPEG],
			input_video: MP4,
			input_audio: WAV,
			duration_s: 4,
			provider_input: {
				first_frame_url: "$input_images.0",
				last_frame_url: "$input_images.1",
				video_url: "$input_video",
				audio_url: "$input_audio",
				options: { guidance: 3.5, tags: ["a", null] },
			},
		};
		expect(asMediaVideoArg(input)).toEqual(input);
		expect(asMediaVideoArg({ prompt: "p", input_images: [PNG] })).toEqual({
			prompt: "p",
			input_images: [PNG],
		});
		// An empty frame list is the same request as no frames.
		expect(asMediaVideoArg({ prompt: "p", input_images: [] })).toEqual({
			prompt: "p",
		});
	});

	const rejects: [string, unknown][] = [
		["three frames", { input_images: [PNG, PNG, PNG] }],
		["a non-array frame list", { input_images: PNG }],
		["an https frame", { input_images: ["https://example.test/a.png"] }],
		["an svg frame", { input_images: ["data:image/svg+xml;base64,PHN2Zz4="] }],
		["a gif frame", { input_images: ["data:image/gif;base64,R0lGOA=="] }],
		["an empty frame payload", { input_images: ["data:image/png;base64,"] }],
		[
			"a non-base64 frame",
			{ input_images: ["data:image/png;base64,not b64!"] },
		],
		["a video passed as audio", { input_audio: MP4 }],
		["audio passed as the clip", { input_video: WAV }],
		["an image passed as the clip", { input_video: PNG }],
		["a remote clip", { input_video: "https://example.test/clip.mp4" }],
		["a zero duration", { duration_s: 0 }],
		["an over-long duration", { duration_s: 601 }],
		["a non-object provider_input", { provider_input: ["video_url"] }],
		["provider_input overriding model", { provider_input: { model: "other" } }],
		[
			"provider_input overriding provider",
			{ provider_input: { provider: "runway" } },
		],
		[
			"provider_input overriding the prompt",
			{ provider_input: { prompt: "x" } },
		],
		[
			"provider_input overriding request_id",
			{ provider_input: { request_id: "x" } },
		],
		["provider_input overriding n", { provider_input: { n: 4 } }],
		[
			"provider_input setting a canonical input",
			{ provider_input: { input_video: MP4 } },
		],
		[
			"provider_input with a non-JSON value",
			{ provider_input: { a: undefined } },
		],
		[
			"provider_input with an own __proto__ key",
			JSON.parse('{"provider_input":{"__proto__":{"model":"x"}}}'),
		],
		[
			"provider_input with a constructor key",
			{ provider_input: { constructor: "x" } },
		],
		[
			"provider_input with a prototype key",
			{ provider_input: { prototype: "x" } },
		],
	];
	for (const [name, fields] of rejects) {
		test(`rejects ${name}`, () => {
			expect(
				asMediaVideoArg({ prompt: "p", provider: "fal", ...(fields as object) })
			).toBeNull();
		});
	}

	test("bounds the combined inline inputs at 40 MiB", () => {
		const half = MAX_MEDIA_INPUT_CHARS / 2;
		const clip = dataUriOfLength("data:video/mp4;base64,", half);
		const track = dataUriOfLength("data:audio/wav;base64,", half);
		expect(
			asMediaVideoArg({ prompt: "p", input_video: clip, input_audio: track })
		).not.toBeNull();
		expect(
			asMediaVideoArg({
				prompt: "p",
				input_video: clip,
				input_audio: track,
				input_images: [PNG],
			})
		).toBeNull();
		expect(
			asMediaVideoArg({
				prompt: "p",
				input_video: clip,
				provider_input: { lyrics: "x".repeat(half) },
			})
		).toBeNull();
	});

	test("dispatch refuses an override before any service runs", async () => {
		let called = false;
		await expect(
			dispatchRpc(
				"media.video",
				[{ prompt: "p", provider_input: { provider: "runway" } }],
				new Set(["media.generate"]),
				{
					listAgents: async () => [],
					registerRoute: async (claim) => ({ path: claim.path }),
					generateVideo: async () => {
						called = true;
						return [];
					},
				}
			)
		).rejects.toMatchObject({ code: "invalid_args" });
		expect(called).toBe(false);
	});
});

describe("asMediaImageArg — provider_input", () => {
	test("forwards a model-specific object and refuses routing keys", () => {
		expect(
			asMediaImageArg({
				prompt: "cat",
				provider: "fal",
				model: "fal-ai/example",
				provider_input: { image_size: "square_hd", seed: 7 },
			})
		).toEqual({
			prompt: "cat",
			provider: "fal",
			model: "fal-ai/example",
			provider_input: { image_size: "square_hd", seed: 7 },
		});
		for (const key of ["model", "provider", "prompt", "request_id", "n"]) {
			expect(
				asMediaImageArg({ prompt: "cat", provider_input: { [key]: "x" } })
			).toBeNull();
		}
		expect(
			asMediaImageArg({ prompt: "cat", provider_input: "seed=7" })
		).toBeNull();
		expect(
			asMediaImageArg(
				JSON.parse('{"prompt":"cat","provider_input":{"__proto__":{"seed":1}}}')
			)
		).toBeNull();
	});

	test("bounds image inputs under Core's 24 MiB image body limit", () => {
		const fifteenMiB = 15 * 1024 * 1024;
		const image = dataUriOfLength("data:image/png;base64,", fifteenMiB);
		// About 30 MiB: inside the 40 MiB video/audio budget, but above the
		// 24 MiB image route limit, so the host must refuse it.
		expect(
			asMediaImageArg({
				prompt: "p",
				provider: "fal",
				model: "m",
				input_images: [image, image],
			})
		).toBeNull();
		expect(
			asMediaImageArg({ prompt: "p", provider: "fal", input_images: [image] })
		).not.toBeNull();
		const half = MAX_MEDIA_IMAGE_INPUT_CHARS / 2;
		const atLimit = dataUriOfLength("data:image/png;base64,", half);
		expect(
			asMediaImageArg({ prompt: "p", input_images: [atLimit, atLimit] })
		).not.toBeNull();
		expect(
			asMediaImageArg({
				prompt: "p",
				input_images: [atLimit, atLimit],
				provider_input: { seed: 1 },
			})
		).toBeNull();
	});

	test("dispatch refuses an oversize image request before any service runs", async () => {
		const image = dataUriOfLength("data:image/png;base64,", 15 * 1024 * 1024);
		let called = false;
		await expect(
			dispatchRpc(
				"media.image",
				[
					{
						prompt: "p",
						provider: "fal",
						model: "m",
						input_images: [image, image],
					},
				],
				new Set(["media.generate"]),
				{
					listAgents: async () => [],
					registerRoute: async (claim) => ({ path: claim.path }),
					generateImage: async () => {
						called = true;
						return [];
					},
				}
			)
		).rejects.toMatchObject({ code: "invalid_args" });
		expect(called).toBe(false);
	});
});

describe("asMediaAudioArg — music and sound effects", () => {
	test("accepts a bounded cloud request and keeps only known fields", () => {
		expect(
			asMediaAudioArg({
				prompt: "  glass shatters  ",
				kind: "sfx",
				duration_s: 2.5,
				provider: "fal",
				model: "fal-ai/example-audio",
				provider_input: { seconds_total: "$duration_s" },
				request_id: "sfx-1",
				extra: "dropped",
			})
		).toEqual({
			prompt: "glass shatters",
			kind: "sfx",
			duration_s: 2.5,
			provider: "fal",
			model: "fal-ai/example-audio",
			provider_input: { seconds_total: "$duration_s" },
			request_id: "sfx-1",
		});
	});

	const base = {
		prompt: "warm piano",
		kind: "music",
		provider: "replicate",
		model: "owner/example-music",
	};
	const rejects: [string, unknown][] = [
		["a missing provider", { provider: undefined }],
		["a missing model", { model: undefined }],
		["a blank prompt", { prompt: "   " }],
		["an unknown kind", { kind: "speech" }],
		["a missing kind", { kind: undefined }],
		["a negative duration", { duration_s: -1 }],
		["a non-finite duration", { duration_s: Number.POSITIVE_INFINITY }],
		["a routing override", { provider_input: { model: "other" } }],
		["a kind override", { provider_input: { kind: "sfx" } }],
		[
			"an oversized provider_input",
			{ provider_input: { a: "x".repeat(MAX_MEDIA_INPUT_CHARS) } },
		],
	];
	for (const [name, fields] of rejects) {
		test(`rejects ${name}`, () => {
			expect(asMediaAudioArg({ ...base, ...(fields as object) })).toBeNull();
		});
	}
});

describe("asModelCompleteArg — vision images", () => {
	test("forwards up to eight png/jpeg/webp data URIs", () => {
		const images = [
			PNG,
			JPEG,
			"data:image/webp;base64,UklGRg==",
			PNG,
			PNG,
			PNG,
			PNG,
			PNG,
		];
		expect(asModelCompleteArg({ prompt: "tag these", images })).toEqual({
			prompt: "tag these",
			images,
		});
		expect(asModelCompleteArg({ prompt: "tag", images: [] })).toEqual({
			prompt: "tag",
		});
	});

	const rejects: [string, unknown][] = [
		["nine images", Array.from({ length: 9 }, () => PNG)],
		["a jpg alias", ["data:image/jpg;base64,/9j/4AAQ"]],
		["a gif", ["data:image/gif;base64,R0lGOA=="]],
		["a remote URL", ["https://example.test/a.png"]],
		["a non-array", PNG],
		[
			"images over 1.5 MiB in total",
			[
				dataUriOfLength(
					"data:image/png;base64,",
					MAX_MODEL_COMPLETE_IMAGE_CHARS / 2 + 4
				),
				dataUriOfLength(
					"data:image/png;base64,",
					MAX_MODEL_COMPLETE_IMAGE_CHARS / 2
				),
			],
		],
	];
	for (const [name, images] of rejects) {
		test(`rejects ${name}`, () => {
			expect(asModelCompleteArg({ prompt: "tag", images })).toBeNull();
		});
	}
});

describe("asWorkflowRunArg — input must be Record<string, string>", () => {
	test("accepts a bare { id } with no input", () => {
		expect(asWorkflowRunArg({ id: "wf-1" })).toEqual({ id: "wf-1" });
	});

	test("accepts an all-string input map", () => {
		expect(
			asWorkflowRunArg({ id: "wf-1", input: { a: "1", b: "two" } })
		).toEqual({ id: "wf-1", input: { a: "1", b: "two" } });
	});

	test("accepts the read-only dry-run flag", () => {
		expect(asWorkflowRunArg({ id: "wf-1", dryRun: true })).toEqual({
			id: "wf-1",
			dryRun: true,
		});
	});

	test("rejects an array input or a non-string input value", () => {
		expect(asWorkflowRunArg({ id: "wf-1", input: ["a"] })).toBeNull();
		expect(asWorkflowRunArg({ id: "wf-1", input: { a: 1 } })).toBeNull();
		expect(asWorkflowRunArg({ id: "wf-1", input: null })).toBeNull();
		expect(asWorkflowRunArg({ id: "wf-1", dryRun: "yes" })).toBeNull();
	});

	test("rejects a missing / empty id", () => {
		expect(asWorkflowRunArg({ id: "" })).toBeNull();
		expect(asWorkflowRunArg({})).toBeNull();
		expect(asWorkflowRunArg(null)).toBeNull();
	});
});

describe("asWorkflowResumeArg", () => {
	test("requires a non-empty runId and a string payload", () => {
		expect(asWorkflowResumeArg({ runId: "r1", payload: "{}" })).toEqual({
			runId: "r1",
			payload: "{}",
		});
		// empty-string payload is allowed (present + string), only runId must be non-empty.
		expect(asWorkflowResumeArg({ runId: "r1", payload: "" })).toEqual({
			runId: "r1",
			payload: "",
		});
	});

	test("rejects a missing payload or empty runId", () => {
		expect(asWorkflowResumeArg({ runId: "r1" })).toBeNull();
		expect(asWorkflowResumeArg({ runId: "", payload: "{}" })).toBeNull();
		expect(asWorkflowResumeArg({ runId: "r1", payload: 5 })).toBeNull();
	});
});

describe("asComposioArg — closed kind set", () => {
	test("accepts each blessed kind with an optional toolkit", () => {
		for (const kind of [
			"status",
			"toolkits",
			"triggers",
			"connections",
		] as const) {
			expect(asComposioArg({ kind })).toEqual({ kind });
		}
		expect(asComposioArg({ kind: "triggers", toolkit: "github" })).toEqual({
			kind: "triggers",
			toolkit: "github",
		});
	});

	test("rejects an unknown kind or a mistyped toolkit", () => {
		expect(asComposioArg({ kind: "list" })).toBeNull();
		expect(asComposioArg({ kind: "status", toolkit: 7 })).toBeNull();
		expect(asComposioArg({})).toBeNull();
		expect(asComposioArg(null)).toBeNull();
	});
});

describe("asPromptArg", () => {
	test("requires a non-empty prompt string", () => {
		expect(asPromptArg({ prompt: "go" })).toEqual({ prompt: "go" });
		expect(asPromptArg({ prompt: "" })).toBeNull();
		expect(asPromptArg({ prompt: 1 })).toBeNull();
		expect(asPromptArg(null)).toBeNull();
	});
});

describe("asRouteClaim", () => {
	test("narrows to { path, title } and drops extra fields", () => {
		expect(
			asRouteClaim({ path: "/plugin/app", title: "Demo", extra: 1 })
		).toEqual({ path: "/plugin/app", title: "Demo" });
	});

	test("rejects a claim missing path or title (never reaches validatePluginRoute)", () => {
		expect(asRouteClaim({ path: "/plugin/app" })).toBeNull();
		expect(asRouteClaim({ title: "Demo" })).toBeNull();
		expect(asRouteClaim({ path: 1, title: "Demo" })).toBeNull();
		expect(asRouteClaim(null)).toBeNull();
	});
});

describe("toRpcError — coded vs plain serialization", () => {
	test("a CodedRpcError becomes a structured { code, message }", () => {
		const out = toRpcError(new CodedRpcError("denied", "nope"));
		expect(out).toEqual({ code: "denied", message: "nope" });
	});

	test("any object carrying a string code is treated as coded", () => {
		expect(toRpcError({ code: "over_budget", message: "too much" })).toEqual({
			code: "over_budget",
			message: "too much",
		});
	});

	test("an unknown string code is normalized to the public server_error code", () => {
		expect(toRpcError({ code: "ENOENT", message: "missing file" })).toEqual({
			code: "server_error",
			message: "missing file",
		});
	});

	test("a plain Error serializes to its message string (legacy plugin shape)", () => {
		expect(toRpcError(new Error("boom"))).toBe("boom");
	});

	test("a non-Error primitive serializes via String()", () => {
		expect(toRpcError("raw string")).toBe("raw string");
		expect(toRpcError(123)).toBe("123");
	});

	test("an object whose code is not a string falls through to String()", () => {
		// code present but numeric → NOT treated as coded; falls to the String() branch.
		const out = toRpcError({ code: 500 });
		expect(out).toBe("[object Object]");
	});
});

describe("capabilitiesFromGrants", () => {
	test("maps known grants and silently ignores unknown ones", () => {
		const caps = capabilitiesFromGrants([
			"storage:kv",
			"totally:made-up",
			"spaces:docs",
			"spaces:database",
		]);
		expect(caps.has("storage.kv")).toBe(true);
		expect(caps.has("spaces.docs")).toBe(true);
		expect(caps.has("spaces.database")).toBe(true);
		// The bogus grant contributes nothing — only the two real caps.
		expect(caps.size).toBe(3);
	});

	test("an empty grant list yields no capabilities", () => {
		expect(capabilitiesFromGrants([]).size).toBe(0);
	});
});
