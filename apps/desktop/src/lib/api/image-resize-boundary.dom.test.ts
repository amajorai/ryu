import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}

import { describe, expect, it, spyOn } from "bun:test";
import {
	type GatewayJsonValue,
	gatewayJsonValueSchema,
} from "./gateway-json-contracts.ts";
import { imageReaderResultSchema } from "./image-generation-contracts.ts";
import { generateImageResize } from "./images.ts";

const target = { url: "http://image-resize-fixture.invalid", token: null };

describe("native browser image resize boundary", () => {
	it("reads actual raster blobs and retains local mask and denoising inputs", async () => {
		let body: GatewayJsonValue;
		const fetch = spyOn(globalThis, "fetch");
		fetch.mockImplementation(
			Object.assign(
				async (...[_input, init]: Parameters<typeof globalThis.fetch>) => {
					body = gatewayJsonValueSchema.parse(JSON.parse(String(init?.body)));
					return Response.json({ data: [{ b64_json: "result" }] });
				},
				{ preconnect: () => {} }
			)
		);
		try {
			expect(
				await generateImageResize(target, {
					aspect: "original",
					denoisingStrength: 0.5,
					engine: "local",
					height: 480,
					width: 640,
					image: new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
					mask: new Blob([new Uint8Array([4, 5, 6])], { type: "image/png" }),
					instructions: "continue the sky",
					signal: new AbortController().signal,
				})
			).toBe("data:image/png;base64,result");
			expect(body).toMatchObject({
				provider: "local",
				denoising_strength: 0.5,
				n: 1,
				size: "640x480",
				input_images: ["data:image/png;base64,AQID"],
				input_mask: "data:image/png;base64,BAUG",
			});
		} finally {
			fetch.mockRestore();
		}
	});
	it("rejects SVG and empty raster inputs before contacting an engine", async () => {
		const fetch = spyOn(globalThis, "fetch");
		try {
			for (const image of [
				new Blob(["<svg/>"], { type: "image/svg+xml" }),
				new Blob([], { type: "image/png" }),
			]) {
				await expect(
					generateImageResize(target, {
						aspect: "original",
						denoisingStrength: 0.5,
						engine: "local",
						height: 480,
						width: 640,
						image,
						instructions: "",
						signal: new AbortController().signal,
					})
				).rejects.toThrow("AI Resize needs a raster image under 16 MB.");
			}
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			fetch.mockRestore();
		}
	});
	it("keeps browser cancellation before file reading and generation", async () => {
		const fetch = spyOn(globalThis, "fetch");
		const controller = new AbortController();
		controller.abort();
		try {
			await expect(
				generateImageResize(target, {
					aspect: "original",
					denoisingStrength: 0.5,
					engine: "local",
					height: 480,
					width: 640,
					image: new Blob(["raster"], { type: "image/png" }),
					instructions: "",
					signal: controller.signal,
				})
			).rejects.toMatchObject({
				name: "AbortError",
				message: "AI Resize cancelled.",
			});
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			fetch.mockRestore();
		}
	});
	it("accepts only native FileReader string results", () => {
		expect(imageReaderResultSchema.parse("")).toBe("");
		expect(imageReaderResultSchema.safeParse(null).success).toBe(false);
		expect(imageReaderResultSchema.safeParse(new ArrayBuffer(3)).success).toBe(
			false
		);
	});
});
