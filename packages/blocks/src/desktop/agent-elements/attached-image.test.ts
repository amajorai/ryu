import { describe, expect, test } from "bun:test";
import { attachedImageSchema } from "./attached-image.ts";

const image = {
	filename: "capture.png",
	id: "capture",
	mimeType: "image/png",
	size: 123,
	url: "blob:attachment",
};

describe("attached image event contract", () => {
	test("retains original native metadata and optional field omission", () => {
		const attachment = {
			...image,
			capturedAt: new Date(),
			metadata: new Map(),
		};
		expect(Object.is(attachedImageSchema.parse(attachment), attachment)).toBe(
			true
		);
		const minimal = { filename: "", id: "", url: "" };
		expect(Object.is(attachedImageSchema.parse(minimal), minimal)).toBe(true);
	});

	test("rejects malformed required and optional image fields", () => {
		for (const value of [
			null,
			[],
			{ ...image, filename: 123 },
			{ ...image, id: null },
			{ ...image, url: undefined },
			{ ...image, mimeType: null },
			{ ...image, size: "123" },
			{ ...image, size: Number.NaN },
			{ ...image, size: Number.POSITIVE_INFINITY },
		]) {
			expect(attachedImageSchema.safeParse(value).success).toBe(false);
		}
	});
});
