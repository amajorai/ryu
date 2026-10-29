import { describe, expect, test } from "bun:test";
import { chatPartsSchema } from "./chatTranscript.ts";
import { sidecarCatalogSchema } from "./sidecar-catalog.ts";

describe("catalog and persisted transcript boundaries", () => {
	test("retains catalog metadata while checking fields used by the CLI", () => {
		const payload = {
			sidecars: [
				{ name: "search", recommended: true, futureMetadata: { version: 2 } },
			],
			futureCatalog: true,
		};
		expect(sidecarCatalogSchema.parse(payload)).toEqual(payload);
		expect(
			sidecarCatalogSchema.safeParse({ sidecars: [{ name: 12 }] }).success
		).toBe(false);
	});

	test("validates all resumed transcript branches and retains tool metadata", () => {
		const parts = [
			{ type: "text", text: "hello" },
			{ type: "reasoning", text: "thinking" },
			{ type: "todo", todos: [{ content: "read", status: "future-status" }] },
			{ type: "error", message: "HTTP 503 · upstream overloaded" },
			{
				type: "tool",
				name: "Read",
				status: "success",
				args: { path: "/tmp/a" },
				result: { lines: ["one"] },
				futureField: true,
			},
		];
		expect(JSON.stringify(chatPartsSchema.parse(parts))).toBe(
			JSON.stringify(parts)
		);
		expect(
			chatPartsSchema.safeParse([
				{ type: "tool", name: "Read", status: "unrecognized" },
			]).success
		).toBe(false);
		expect(
			chatPartsSchema.safeParse([{ type: "todo", todos: [null] }]).success
		).toBe(false);
		expect(chatPartsSchema.safeParse([{ type: "error" }]).success).toBe(false);
	});
});
