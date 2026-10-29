import { expect, test } from "bun:test";
import { ownsMcpForms } from "./mcp-form-owner.ts";

const target = {
	url: "http://fixture.test",
	token: "actor-one",
	userJwt: "identity-one",
};
test("an inherited conversation owner suppresses only the same actor's duplicate form presenter", () => {
	const owner = { target, conversationId: "conversation" };
	expect(ownsMcpForms(owner, target, "conversation")).toBe(true);
	expect(ownsMcpForms(owner, target, "other-conversation")).toBe(false);
	expect(
		ownsMcpForms(owner, { ...target, token: "actor-two" }, "conversation")
	).toBe(false);
	expect(
		ownsMcpForms(owner, { ...target, userJwt: "identity-two" }, "conversation")
	).toBe(false);
	expect(
		ownsMcpForms(
			owner,
			{ ...target, url: "http://other-fixture.test" },
			"conversation"
		)
	).toBe(false);
	expect(ownsMcpForms(null, target, "conversation")).toBe(false);
	expect(
		ownsMcpForms({ target, conversationId: null }, target, "conversation")
	).toBe(false);
	expect(ownsMcpForms(owner, target, undefined)).toBe(false);
});
