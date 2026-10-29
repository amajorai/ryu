import { describe, expect, test } from "bun:test";
import {
	nextFormPollDelay,
	parseMcpForms,
	safeThumbnail,
	validateFormValues,
} from "./mcp-form-schema.ts";

const payload = {
	forms: [
		{
			id: "form-1",
			conversation_id: "chat-1",
			server: "design",
			message: "Choose a design",
			requested_schema: {
				type: "object",
				required: ["design"],
				properties: {
					design: {
						type: "string",
						oneOf: [
							{
								const: "blue",
								title: "Blue",
								"x-openai-thumbnail": "https://example.com/blue.png",
							},
							{ const: "green", title: "Green" },
						],
					},
					count: { type: "integer", minimum: 1, maximum: 5 },
				},
			},
		},
	],
};
describe("MCP forms", () => {
	test("idle and failed polls back off while pending forms restore responsive polling", () => {
		expect(nextFormPollDelay(1500, false)).toBe(3000);
		expect(nextFormPollDelay(6000, false)).toBe(8000);
		expect(nextFormPollDelay(8000, true)).toBe(1500);
	});
	test("preserves choice labels, thumbnails and conversation scope", () => {
		const form = parseMcpForms(payload)[0];
		expect(form?.conversationId).toBe("chat-1");
		expect(form?.fields[0]?.choices[0]).toEqual({
			value: "blue",
			label: "Blue",
			thumbnail: "https://example.com/blue.png",
		});
	});
	test("accepts the canonical camelCase Core form envelope", () => {
		const original = payload.forms[0];
		const form = parseMcpForms({
			forms: [
				{
					id: original.id,
					conversationId: original.conversation_id,
					server: original.server,
					message: original.message,
					requestedSchema: original.requested_schema,
				},
			],
		})[0];
		expect(form?.conversationId).toBe("chat-1");
		expect(form?.fields.length).toBe(2);
	});
	test("rejects missing, unknown choices, non-finite numbers and constraints", () => {
		const fields = parseMcpForms(payload)[0]?.fields ?? [];
		expect(validateFormValues(fields, {})).toBeDefined();
		expect(validateFormValues(fields, { design: "red" })).toBeDefined();
		expect(
			validateFormValues(fields, { design: "blue", count: 6 })
		).toBeDefined();
		expect(
			validateFormValues(fields, { design: "blue", count: 1.5 })
		).toBeDefined();
		expect(
			validateFormValues(fields, { design: "blue", count: Number.NaN })
		).toBeDefined();
		expect(
			validateFormValues(fields, { design: "blue", count: 3 })
		).toBeUndefined();
	});
	test("remote thumbnails exclude credentialed and active schemes", () => {
		for (const value of [
			"javascript:alert(1)",
			"data:image/svg+xml,bad",
			"file:///secret",
			"https://user:pass@example.com/image",
			"http://example.com/image",
		]) {
			expect(safeThumbnail(value)).toBeUndefined();
		}
	});
	test("malformed server payloads fail at the boundary", () => {
		expect(() =>
			parseMcpForms({ forms: [{ requested_schema: {} }] })
		).toThrow();
		expect(() => parseMcpForms({ forms: "wrong" })).toThrow();
	});
	test("supports MCP Icon thumbnails including inert data images", () => {
		expect(safeThumbnail({ src: "https://example.com/blue.png" })).toBe(
			"https://example.com/blue.png"
		);
		expect(safeThumbnail({ src: "data:image/png;base64,aGVsbG8=" })).toBe(
			"data:image/png;base64,aGVsbG8="
		);
		expect(
			safeThumbnail({ src: "data:image/svg+xml;base64,aGVsbG8=" })
		).toBeUndefined();
	});
	test("array suggestions allow entered text; supplied resources constrain URI selections", () => {
		const form = parseMcpForms({
			forms: [
				{
					id: "rich",
					conversation_id: "chat",
					server: "parts",
					message: "Choose",
					requested_schema: {
						type: "object",
						properties: {
							accessories: {
								type: "array",
								items: {
									type: "string",
									"x-openai-suggestions": [
										{ const: "washer", title: "Washer" },
									],
								},
								minItems: 1,
							},
							reference: {
								type: "string",
								"x-openai-input": {
									type: "resource",
									options: [{ uri: "cad://bolt", name: "bolt", title: "Bolt" }],
								},
							},
						},
					},
				},
			],
		})[0];
		expect(form?.fields[0]?.suggestions).toBe(true);
		expect(
			validateFormValues(form?.fields ?? [], {
				accessories: ["custom"],
				reference: "cad://bolt",
			})
		).toBeUndefined();
		expect(
			validateFormValues(form?.fields ?? [], {
				accessories: [],
				reference: "cad://bolt",
			})
		).toBeDefined();
		expect(
			validateFormValues(form?.fields ?? [], {
				accessories: ["custom"],
				reference: "cad://unknown",
			})
		).toBeDefined();
	});
});
