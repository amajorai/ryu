import { describe, expect, it } from "bun:test";
import {
	type GatewayJsonValue,
	gatewayJsonValueSchema,
} from "./gateway-json-contracts.ts";
import {
	imageDataUrl,
	imageGenerationReplySchema,
} from "./image-generation-contracts.ts";
import { generateImage } from "./images.ts";

interface CapturedGeneration {
	authorization: string | null;
	body: GatewayJsonValue;
}

describe("native image generation transport", () => {
	it("retains engine rows and future JSON metadata by identity", () => {
		const data = [
			{
				url: "https://images.invalid/result.png",
				b64_json: "ignored",
				metadata: JSON.parse('{"__proto__":{"future":true}}'),
			},
		];
		const reply = { created: 100, data, future: [true, null] };
		const parsed = imageGenerationReplySchema.parse(reply);
		expect(parsed).toBe(reply);
		expect(parsed.data).toBe(data);
		expect(
			imageGenerationReplySchema.safeParse({ data: [{ url: 4 }] }).success
		).toBe(false);
		expect(
			imageGenerationReplySchema.safeParse({ data: [{ b64_json: false }] })
				.success
		).toBe(false);
	});
	it("sends exact generation inputs and prefers hosted URLs before base64", async () => {
		const captured: CapturedGeneration = {
			authorization: null,
			body: undefined,
		};
		const server = Bun.serve({
			port: 0,
			async fetch(request) {
				captured.body = gatewayJsonValueSchema.parse(await request.json());
				captured.authorization = request.headers.get("authorization");
				return Response.json({
					data: [
						{ url: "https://images.invalid/result.png", b64_json: "unused" },
						{ b64_json: "encoded" },
						{ url: "", b64_json: "fallback" },
						{ b64_json: "webp", media_type: "image/webp" },
						{},
					],
					future: { engine: "metadata" },
				});
			},
		});
		try {
			expect(
				await generateImage(
					{ url: server.url.origin, token: "fixture-token" },
					"A tree",
					{
						count: 2,
						provider: "fal",
						model: "future/model",
						size: "512x512",
						requestId: "one",
						denoisingStrength: 0.5,
						inputImages: ["data:image/png;base64,source"],
						inputMask: "data:image/png;base64,mask",
					}
				)
			).toEqual([
				"https://images.invalid/result.png",
				"data:image/png;base64,encoded",
				"data:image/png;base64,fallback",
				"data:image/webp;base64,webp",
			]);
			expect(captured.body).toEqual({
				prompt: "A tree",
				denoising_strength: 0.5,
				n: 2,
				size: "512x512",
				request_id: "one",
				provider: "fal",
				model: "future/model",
				input_images: ["data:image/png;base64,source"],
				input_mask: "data:image/png;base64,mask",
			});
			expect(captured.authorization).toBe("Bearer fixture-token");
		} finally {
			server.stop(true);
		}
	});
	it("labels base64 images with their reported raster media type", () => {
		expect(imageDataUrl("AA", "image/jpeg")).toBe("data:image/jpeg;base64,AA");
		expect(imageDataUrl("AA", " IMAGE/WEBP ")).toBe(
			"data:image/webp;base64,AA"
		);
		expect(imageDataUrl("AA", undefined)).toBe("data:image/png;base64,AA");
		expect(imageDataUrl("AA", "image/svg+xml")).toBe(
			"data:image/png;base64,AA"
		);
		expect(imageDataUrl("AA", "text/html;base64,")).toBe(
			"data:image/png;base64,AA"
		);
		expect(
			imageGenerationReplySchema.safeParse({
				data: [{ b64_json: "AA", media_type: 4 }],
			}).success
		).toBe(false);
	});
	it("retains empty replies, engine refusal messages, and native aborts", async () => {
		let mode = "empty";
		const server = Bun.serve({
			port: 0,
			fetch() {
				if (mode === "refused") {
					return Response.json(
						{ error: "provider unavailable" },
						{ status: 503 }
					);
				}
				if (mode === "non-json") {
					return new Response("upstream unavailable", { status: 502 });
				}
				return Response.json({ data: null });
			},
		});
		const target = { url: server.url.origin, token: null };
		try {
			expect(await generateImage(target, "A tree")).toEqual([]);
			mode = "refused";
			await expect(generateImage(target, "A tree")).rejects.toThrow(
				"provider unavailable"
			);
			mode = "non-json";
			await expect(generateImage(target, "A tree")).rejects.toThrow(
				"image generation failed: 502"
			);
			const controller = new AbortController();
			controller.abort();
			await expect(
				generateImage(target, "A tree", { signal: controller.signal })
			).rejects.toMatchObject({ name: "AbortError" });
		} finally {
			server.stop(true);
		}
	});
});
