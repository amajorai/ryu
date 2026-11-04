import { describe, expect, mock, test } from "bun:test";
import * as transformers from "@huggingface/transformers";

import type { BrowserImageRuntimeStatus } from "./image-runtime.ts";
import { BROWSER_IMAGE_STATUS_CODES } from "./status-codes.ts";

// The runtime imports Transformers.js lazily; replace only its pipeline
// factory so no model is downloaded. Everything else stays the real module.
let failNextPipeline = false;
const fakePipeline = (
	task: string,
	_modelId: string,
	options: { progress_callback?: (info: unknown) => void }
) => {
	if (failNextPipeline) {
		failNextPipeline = false;
		return Promise.reject(new Error("wasm backend missing"));
	}
	options.progress_callback?.({ status: "initiate" });
	options.progress_callback?.({ progress: 42.4, status: "progress" });
	if (task === "image-segmentation") {
		const mask = new transformers.RawImage(new Uint8Array([0, 255]), 2, 1, 1);
		return Promise.resolve(() =>
			Promise.resolve([
				{ label: "cat", mask, score: 0.9 },
				{ label: "dog", mask, score: 0.8 },
			])
		);
	}
	const pixels = new transformers.RawImage(new Uint8Array([1, 2, 3]), 1, 1, 3);
	return Promise.resolve(() => Promise.resolve(pixels));
};
mock.module("@huggingface/transformers", () => ({
	...transformers,
	env: {},
	pipeline: fakePipeline,
}));

const { createBrowserLocalImageRuntime } = await import("./image-runtime.ts");

const image = new Blob([new Uint8Array([1])], { type: "image/png" });

function record() {
	const runtime = createBrowserLocalImageRuntime();
	const seen: BrowserImageRuntimeStatus[] = [];
	runtime.subscribe((status) => seen.push(status));
	return { runtime, seen };
}

describe("image runtime status codes", () => {
	test("segmentation publishes codes with device, progress and count", async () => {
		const { runtime, seen } = record();
		await runtime.segment({ image, modelId: "org/segmenter" });

		expect(seen.map((status) => status.status)).toEqual([
			{ code: "segmentation.preparing", values: { device: "wasm" } },
			{
				code: "segmentation.downloading",
				values: { device: "wasm", progress: undefined },
			},
			{
				code: "segmentation.downloading",
				values: { device: "wasm", progress: 42.4 },
			},
			{ code: "segmentation.ready" },
			{ code: "segmentation.running" },
			{ code: "segments.found", values: { count: 2 } },
		]);
		// The English line is kept for logs and older consumers.
		expect(seen.at(-1)?.statusMessage).toBe("2 subjects found.");
	});

	test("background removal ends with the removed code", async () => {
		const { runtime, seen } = record();
		await runtime.removeBackground({ image, modelId: "org/remover" });

		expect(seen.map((status) => status.status?.code)).toEqual([
			"background.preparing",
			"background.downloading",
			"background.downloading",
			"background.ready",
			"background.running",
			"background.removed",
		]);
	});

	test("a failed pipeline carries the raw cause as a detail value", async () => {
		const { runtime, seen } = record();
		failNextPipeline = true;
		await expect(
			runtime.segment({ image, modelId: "org/broken" })
		).rejects.toThrow("wasm backend missing");

		expect(seen.at(-1)?.status).toEqual({
			code: "segmentation.failed",
			values: {
				detail:
					"The segmentation model could not be prepared: wasm backend missing",
			},
		});
	});

	test("every published code is a declared code", async () => {
		const { runtime, seen } = record();
		await runtime.segment({ image, modelId: "org/segmenter-2" });
		await runtime.removeBackground({ image, modelId: "org/remover-2" });
		const declared: readonly (string | undefined)[] =
			BROWSER_IMAGE_STATUS_CODES;
		for (const status of seen) {
			expect(declared).toContain(status.status?.code);
		}
	});
});
