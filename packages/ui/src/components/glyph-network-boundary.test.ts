import { describe, expect, spyOn, test } from "bun:test";
import { ZodError } from "zod";
import { searchGlyphIcons } from "./glyph.ts";

async function withResponse(
	body: string,
	run: () => Promise<void>,
	status = 200
) {
	const responseFetch = new Proxy(globalThis.fetch, {
		apply() {
			return Promise.resolve(
				new Response(body, {
					status,
					headers: { "Content-Type": "application/json" },
				})
			);
		},
	});
	const request = spyOn(globalThis, "fetch").mockImplementation(responseFetch);
	try {
		await run();
	} finally {
		request.mockRestore();
	}
}

describe("Iconify consumed response boundary", () => {
	test("preserves search order and duplicates while ignoring unrelated collection metadata", async () => {
		await withResponse(
			'{"icons":["lucide:heart","lucide:heart","lucide:star"],"categories":7,"future":{"ok":true}}',
			async () => {
				const hits = await searchGlyphIcons(" heart ", 2);
				expect(hits.map((hit) => hit.id)).toEqual([
					"lucide:heart",
					"lucide:heart",
					"lucide:star",
				]);
				expect(hits.map((hit) => new URL(hit.previewUrl).pathname)).toEqual([
					"/lucide/heart.svg",
					"/lucide/heart.svg",
					"/lucide/star.svg",
				]);
			}
		);
	});
	test("retains collection own-key order, including __proto__, then uses original slicing", async () => {
		await withResponse(
			'{"uncategorized":["first"],"categories":{"2":["second"],"__proto__":["third"],"last":["fourth"]},"icons":42}',
			async () => {
				const hits = await searchGlyphIcons("", 3);
				expect(hits.map((hit) => hit.id)).toEqual([
					"lucide:first",
					"lucide:second",
					"lucide:third",
				]);
			}
		);
	});
	test("missing and null optional lists retain empty fallbacks", async () => {
		for (const body of [
			"{}",
			'{"icons":null,"uncategorized":null,"categories":null}',
		]) {
			await withResponse(body, async () => {
				expect(await searchGlyphIcons("heart")).toEqual([]);
				expect(await searchGlyphIcons("")).toEqual([]);
			});
		}
	});
	test("rejects malformed consumed array entries before constructing hits", async () => {
		for (const body of ['{"icons":["lucide:heart",7]}', '{"icons":{}}']) {
			await withResponse(body, async () => {
				await expect(searchGlyphIcons("heart")).rejects.toBeInstanceOf(
					ZodError
				);
			});
		}
		for (const body of [
			'{"uncategorized":[7]}',
			'{"categories":{"misc":["heart",7]}}',
			'{"categories":"heart"}',
		]) {
			await withResponse(body, async () => {
				await expect(searchGlyphIcons("")).rejects.toBeInstanceOf(ZodError);
			});
		}
	});
	test("retains actual HTTP failure before JSON decoding and native malformed JSON rejection", async () => {
		await withResponse(
			"not JSON",
			async () => {
				await expect(searchGlyphIcons("heart")).rejects.toThrow(
					"icon search failed: 503"
				);
			},
			503
		);
		await withResponse("not JSON", async () => {
			await expect(searchGlyphIcons("heart")).rejects.toThrow();
		});
	});
});
