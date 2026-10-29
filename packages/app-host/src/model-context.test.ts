import { describe, expect, test } from "bun:test";
import {
	modelContextParts,
	parseModelContext,
	useModelContextStore,
} from "./model-context.ts";

describe("model context", () => {
	test("embedded binary resources become model file attachments without private metadata", () => {
		const input = parseModelContext({
			content: [
				{
					type: "resource",
					resource: {
						uri: "host-resource://selected.pdf",
						blob: "YWJj",
						mimeType: "application/pdf",
						_meta: { secret: "private" },
					},
					_meta: { "openai/title": "Selected document", secret: "private" },
				},
			],
		});
		useModelContextStore
			.getState()
			.update("binary-resource", "binary-owner", input);
		expect(modelContextParts("binary-resource")).toEqual([
			{
				type: "file",
				mediaType: "application/pdf",
				url: "data:application/pdf;base64,YWJj",
			},
		]);
		expect(JSON.stringify(modelContextParts("binary-resource"))).not.toContain(
			"private"
		);
		expect(() =>
			parseModelContext({
				content: [
					{
						type: "resource",
						resource: {
							uri: "x",
							blob: "YWJj",
							mimeType: "application/pdf;base64,unexpected",
						},
					},
				],
			})
		).toThrow("MIME");
		useModelContextStore.getState().clear("binary-owner");
	});
	test("filters malformed presentation and audiences while retaining the model payload", () => {
		const input = parseModelContext({
			content: [
				{
					type: "text",
					text: "context",
					annotations: { audience: ["assistant", "other", 7, "user"] },
					_meta: {
						"openai/title": "x".repeat(300),
						"openai/thumbnail": { src: "http://example.com/image" },
						private: "secret",
					},
				},
			],
		});
		expect(input.content?.[0]).toEqual({
			type: "text",
			text: "context",
			annotations: { audience: ["assistant", "user"] },
			_meta: { "openai/title": "x".repeat(256) },
		});
		expect(
			parseModelContext({
				content: [
					{ type: "text", text: "plain", annotations: false, _meta: null },
				],
			})
		).toEqual({ content: [{ type: "text", text: "plain" }] });
	});
	test("keeps text resource precedence and defaults only absent binary MIME types", () => {
		expect(
			parseModelContext({
				content: [
					{
						type: "resource",
						resource: { uri: "r", text: "readable", blob: "YWJj", mimeType: 7 },
					},
				],
			})
		).toEqual({
			content: [{ type: "resource", resource: { uri: "r", text: "readable" } }],
		});
		expect(
			parseModelContext({
				content: [{ type: "resource", resource: { uri: "r", blob: "YWJj" } }],
			}).content?.[0]
		).toEqual({
			type: "resource",
			resource: {
				uri: "r",
				blob: "YWJj",
				mimeType: "application/octet-stream",
			},
		});
		expect(() =>
			parseModelContext({
				content: [
					{
						type: "resource",
						resource: { uri: "r", blob: "YWJj", mimeType: undefined },
					},
				],
			})
		).toThrow("MIME");
		expect(() => parseModelContext({ content: undefined })).toThrow();
		expect(() => parseModelContext({ structuredContent: undefined })).toThrow();
	});

	test("keeps updateId when content and structuredContent are supplied together", () => {
		const store = useModelContextStore.getState();
		const mixed = parseModelContext({
			structuredContent: { selected: 1 },
			content: [{ type: "text", text: "mixed" }],
		});
		const first = store.update("mixed", "app-mixed", mixed);
		expect(store.update("mixed", "app-mixed", mixed).updateId).toBe(
			first.updateId
		);
		store.clear("app-mixed");
	});
	test("replaces one instance idempotently and isolates conversations", () => {
		const store = useModelContextStore.getState();
		const initial = parseModelContext({
			content: [{ type: "text", text: "first" }],
			_meta: { secret: "private" },
		});
		const first = store.update("conversation-a", "app-a", initial);
		expect(store.update("conversation-a", "app-a", initial).updateId).toBe(
			first.updateId
		);
		store.update("conversation-b", "app-b", {
			structuredContent: { selected: 2 },
		});
		expect(JSON.stringify(modelContextParts("conversation-a"))).not.toContain(
			"private"
		);
		expect(JSON.stringify(modelContextParts("conversation-a"))).not.toContain(
			"selected"
		);
		const replacement = store.update("conversation-a", "app-a", {
			content: [{ type: "text", text: "second" }],
		});
		expect(replacement.updateId).not.toBe(first.updateId);
		expect(JSON.stringify(modelContextParts("conversation-a"))).not.toContain(
			"first"
		);
		store.clear("app-a");
		store.clear("app-b");
	});
	test("projects typed resources and inline images without remote fetches", () => {
		const input = parseModelContext({
			content: [
				{ type: "image", mimeType: "image/png", data: "YWJj" },
				{ type: "resource", resource: { uri: "file:///note", text: "note" } },
				{
					type: "resource_link",
					uri: "https://example.com/item",
					name: "Item",
				},
			],
		});
		useModelContextStore.getState().update("images", "app-images", input);
		expect(modelContextParts("images")).toContainEqual({
			type: "file",
			mediaType: "image/png",
			url: "data:image/png;base64,YWJj",
		});
		expect(JSON.stringify(modelContextParts("images"))).toContain("note");
		useModelContextStore.getState().clear("app-images");
	});
	test("rejects malformed and oversized content", () => {
		expect(() =>
			parseModelContext({
				content: [{ type: "image", mimeType: "text/html", data: "YWJj" }],
			})
		).toThrow();
		expect(() =>
			parseModelContext({
				content: [{ type: "resource", resource: { uri: "a", blob: "!" } }],
			})
		).toThrow();
		expect(() =>
			parseModelContext({
				content: [{ type: "text", text: "a".repeat(2_000_001) }],
			})
		).toThrow();
	});
	test("keeps presentation and hidden audience outside model text, removal renews state", () => {
		const store = useModelContextStore.getState();
		const state = store.update(
			"attachments",
			"attachments-owner",
			parseModelContext({
				content: [
					{
						type: "text",
						text: "model text",
						_meta: {
							"openai/title": "Display title",
							"openai/thumbnail": { src: "https://example.com/thumb.png" },
						},
						annotations: { audience: ["assistant"] },
					},
					{ type: "text", text: "remove me" },
				],
			})
		);
		expect(state.content?.[0]?.annotations?.audience).toEqual(["assistant"]);
		expect(state.content?.[0]?._meta?.["openai/title"]).toBe("Display title");
		expect(JSON.stringify(modelContextParts("attachments"))).not.toContain(
			"Display title"
		);
		store.remove("attachments-owner", 1);
		expect(store.get("attachments", "attachments-owner")?.updateId).not.toBe(
			state.updateId
		);
		expect(JSON.stringify(modelContextParts("attachments"))).not.toContain(
			"remove me"
		);
		store.remove("attachments-owner", 0);
		expect(store.get("attachments", "attachments-owner")).toBeNull();
	});
});
