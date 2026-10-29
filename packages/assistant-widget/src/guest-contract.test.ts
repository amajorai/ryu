import { expect, test } from "bun:test";
import {
	guestChatInputSchema,
	guestChatStreamSchema,
} from "./guest-contract.ts";

test("accepts only a trimmed, bounded question and drops any model choice", () => {
	expect(guestChatInputSchema.parse({ question: " Hello " })).toEqual({
		question: "Hello",
	});
	expect(
		guestChatInputSchema.parse({ model: "private-model", question: "Hi" })
	).toEqual({ question: "Hi" });
	expect(guestChatInputSchema.safeParse({ question: " " }).success).toBe(false);
	expect(
		guestChatInputSchema.safeParse({ question: "a".repeat(4001) }).success
	).toBe(false);
});

test("preserves streaming error precedence and first-choice malformed fallbacks", () => {
	const error = guestChatStreamSchema.parse({
		error: { message: "" },
		choices: [{ delta: { content: "ignored" } }],
	});
	expect(error.error?.message).toBe("");
	expect(
		guestChatStreamSchema.parse({ error: { message: 7 } }).error?.message
	).toBeUndefined();
	const choices = guestChatStreamSchema.parse({
		choices: [null, { delta: { content: "later" } }],
	}).choices;
	expect(choices?.[0]).toBeUndefined();
	expect(choices?.[1]?.delta?.content).toBe("later");
	expect(
		guestChatStreamSchema.parse({ choices: [{ delta: { content: 7 } }] })
			.choices?.[0]?.delta?.content
	).toBeUndefined();
});
