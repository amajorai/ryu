import { afterAll, beforeEach, expect, test } from "bun:test";
import type { z } from "zod";
import {
	uploadErrorViewSchema,
	uploadIndexSchema,
	uploadLegacyViewSchema,
	uploadPublisherSchema,
} from "./upload-wire-contracts.ts";
import { uploadUserFile } from "./uploads.ts";

const index = {
	document_id: "native-doc",
	state: "indexed",
	reason_code: null,
	message: null,
	backend_id: "builtin",
	backend_version: null,
	chunk_count: 1,
	warnings: ["native warning"],
	updated_at: 9_007_199_254_740_992,
} satisfies z.output<typeof uploadIndexSchema>;
const full = {
	id: "native-doc",
	space_id: "uploads",
	file_name: "雪.txt",
	url: "/api/uploads/native-doc",
	size: 9_007_199_254_740_992,
	content_type: "text/plain",
	index,
} satisfies z.output<typeof uploadPublisherSchema>;
const requests: {
	authorization: string | null;
	body: string;
	contentType: string | null;
	filename: string | null;
	method: string;
	path: string;
}[] = [];
const reply = { body: JSON.stringify(full), status: 200 };
const server = Bun.serve({
	port: 0,
	async fetch(request) {
		requests.push({
			authorization: request.headers.get("Authorization"),
			body: await request.text(),
			contentType: request.headers.get("Content-Type"),
			filename: request.headers.get("x-filename"),
			method: request.method,
			path: new URL(request.url).pathname,
		});
		return new Response(reply.body, {
			status: reply.status,
			headers: { "Content-Type": "application/json" },
		});
	},
});
afterAll(() => server.stop(true));
beforeEach(() => {
	reply.body = JSON.stringify(full);
	reply.status = 200;
	requests.length = 0;
});
const target = {
	url: `http://127.0.0.1:${server.port}`,
	token: "native-token",
	userJwt: "native-user",
};

test("full seven-field publisher and nine-field index retain raw future metadata and unsafe-width native integers", () => {
	const value = { ...full, future: { retained: ["雪", null] } };
	Object.defineProperty(value, "__proto__", {
		value: { native: "metadata" },
		enumerable: true,
	});
	expect(uploadPublisherSchema.parse(value)).toBe(value);
	expect(uploadIndexSchema.parse(index)).toBe(index);
	expect(uploadLegacyViewSchema.parse(value)).toBe(value);
	for (const invalid of [
		{ ...full, index: { ...index, warnings: [42] } },
		{ ...full, space_id: 42 },
		{ ...full, size: "42" },
	]) {
		expect(uploadPublisherSchema.safeParse(invalid).success).toBe(false);
	}
});
test("explicit legacy return view admits absent/null metadata without claiming full publisher completeness", () => {
	for (const value of [
		{ id: "native-doc", url: "/api/uploads/native-doc" },
		{
			...full,
			file_name: null,
			space_id: null,
			content_type: null,
			size: null,
		},
	]) {
		expect(uploadLegacyViewSchema.parse(value)).toBe(value);
		expect(uploadPublisherSchema.safeParse(value).success).toBe(false);
	}
});
test("real HTTP upload retains native request headers/body and complete/legacy fallback outputs", async () => {
	const body = new Blob(["native bytes 雪"], { type: "text/plain" });
	for (const fixture of [
		full,
		{ id: "native-doc", url: "/api/uploads/native-doc" },
		{
			...full,
			file_name: null,
			space_id: null,
			size: null,
			content_type: null,
		},
	]) {
		reply.body = JSON.stringify(fixture);
		const value = await uploadUserFile(target, body, {
			fileName: "native.txt",
			contentType: "text/plain",
		});
		expect(value.id).toBe("native-doc");
		expect(value.url).toBe("/api/uploads/native-doc");
		expect(value.size).toBe(
			"size" in fixture ? (fixture.size ?? body.size) : body.size
		);
		expect(value.fileName).toBe(
			"file_name" in fixture
				? (fixture.file_name ?? "native.txt")
				: "native.txt"
		);
		expect(requests.at(-1)).toEqual({
			authorization: "Bearer native-token",
			body: "native bytes 雪",
			contentType: "text/plain",
			filename: "native.txt",
			method: "POST",
			path: "/api/uploads",
		});
	}
});
test("native error detail string coercion remains intact for truthy JSON and invalid JSON fallback", async () => {
	for (const fixture of [
		{ error: "native refusal" },
		{ error: 42 },
		{ error: ["native", "error"] },
		{ error: false },
		{ error: null },
	]) {
		expect(uploadErrorViewSchema.parse(fixture)).toBe(fixture);
		reply.status = 413;
		reply.body = JSON.stringify(fixture);
		await expect(
			uploadUserFile(target, new Blob(["bytes"]), { fileName: "native.txt" })
		).rejects.toThrow(
			`Upload failed (413)${fixture.error ? `: ${fixture.error}` : ""}`
		);
	}
	reply.body = "not-json";
	await expect(
		uploadUserFile(target, new Blob(["bytes"]), { fileName: "native.txt" })
	).rejects.toThrow("Upload failed (413)");
});
