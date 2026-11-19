import { expect, test } from "bun:test";
import { translate } from "@ryu/i18n/core";
import { profileErrorMessage } from "./OnboardingSetupStep.profile-errors.ts";

test("each failure code gets its own sentence", () => {
	const sentences = [
		"expired",
		"empty_draft",
		"context_changed",
		"company_knowledge_disabled",
	].map((code) => profileErrorMessage(code, translate));
	expect(sentences).toEqual([
		"The profile build took too long and was stopped. Try again to start a new build.",
		"The agent finished without writing a profile draft.",
		"This node's setup changed while the profile was building. Try again to build it for the current setup.",
		"Shared company knowledge is turned off for this node, so the draft was not saved.",
	]);
});

test("a generic, unknown, or missing code gets the general sentence", () => {
	for (const code of ["failed", "not-a-code", null]) {
		expect(profileErrorMessage(code, translate)).toBe(
			"The agent could not finish the first draft."
		);
	}
});
