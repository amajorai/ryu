import { expect, test } from "bun:test";
import {
	herdrFixtureChatSchema,
	herdrFixturePromptSchema,
	herdrFixtureTurnSchema,
	mergedBodyFields,
	mergedFixtureChatSchema,
	parseFixtureJson,
} from "./cli-fixture-contract.ts";

const request = {
	agent_id: "agent-reviewer",
	conversation_id: "proof-chat",
	enable_long_term: false,
	messages: [
		{ role: "user", content: [{ type: "text", text: "advertise commands" }] },
	],
};

test("merged fixture checks exact routing and single text parts without discarding permitted message metadata", () => {
	expect(mergedFixtureChatSchema.safeParse(request).success).toBe(true);
	expect(
		mergedFixtureChatSchema.safeParse({
			...request,
			messages: [{ ...request.messages[0], extra: { retained: true } }],
		}).success
	).toBe(true);
	for (const invalid of [
		{ ...request, agent_id: "foreign" },
		{ ...request, conversation_id: "" },
		{ ...request, enable_long_term: true },
		{ ...request, messages: [] },
		{ ...request, extra: "unexpected" },
		{
			...request,
			messages: [{ role: "user", content: [{ type: "image", text: "bad" }] }],
		},
		{
			...request,
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "a" },
						{ type: "text", text: "b" },
					],
				},
			],
		},
	]) {
		expect(mergedFixtureChatSchema.safeParse(invalid).success).toBe(false);
	}
});

test("raw JSON routing retains special own fields so unsupported top-level keys remain rejectable", () => {
	const parsed = parseFixtureJson(
		'{"__proto__":{"private":true},"messages":[]}'
	);
	expect(Object.keys(parsed ?? {})).toContain("__proto__");
	expect(
		Object.keys(parsed ?? {}).some((key) => !mergedBodyFields.has(key))
	).toBe(true);
	expect(() => parseFixtureJson("{")).toThrow();
});

test("Herdr validates request, turn, and prompt boundaries separately while accepting opaque routing metadata", () => {
	expect(
		herdrFixtureChatSchema.safeParse({
			conversation_id: "",
			messages: [],
			routing: { arbitrary: true },
		}).success
	).toBe(true);
	expect(
		herdrFixtureChatSchema.safeParse({ conversation_id: 12, messages: [] })
			.success
	).toBe(false);
	expect(
		herdrFixtureTurnSchema.safeParse({ content: [{ text: "permission" }] })
			.success
	).toBe(true);
	expect(
		herdrFixtureTurnSchema.safeParse({ content: "permission" }).success
	).toBe(false);
	expect(
		herdrFixturePromptSchema.safeParse({ text: "permission", type: "text" })
			.success
	).toBe(true);
	expect(herdrFixturePromptSchema.safeParse({ text: 12 }).success).toBe(false);
});
