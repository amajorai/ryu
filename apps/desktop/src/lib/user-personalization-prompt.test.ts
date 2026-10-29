import { describe, expect, test } from "bun:test";
import { DEFAULT_USER_PERSONALIZATION } from "@/src/lib/api/preferences.ts";
import {
	changedPersonalizationFields,
	personalizationCacheWarning,
} from "./user-personalization-prompt.ts";

const saved = {
	aboutOrganization: "Cedar Research Group",
	aboutYou: "I build accessible tools.",
	nickname: "Rae",
	occupation: "Engineer",
};

describe("About you prompt-cache confirmation", () => {
	test("an unchanged or whitespace-only edit asks nothing", () => {
		expect(changedPersonalizationFields(saved, { ...saved })).toEqual([]);
		expect(
			personalizationCacheWarning(saved, {
				...saved,
				nickname: "  Rae ",
				aboutYou: "I build accessible tools.\n",
			})
		).toBeNull();
	});

	test("names each changed field in prompt order and reaches every thread", () => {
		const after = {
			...saved,
			aboutOrganization: "",
			nickname: "Ray",
		};
		expect(changedPersonalizationFields(saved, after)).toEqual([
			"Nickname",
			"About your organization",
		]);
		const warning = personalizationCacheWarning(saved, after);
		expect(warning?.title).toBe("Apply now? This resets the prompt cache");
		expect(warning?.description).toStartWith(
			"Nickname and About your organization are part of the system prompt for every thread on this node."
		);
	});

	test("filling an empty profile counts as a change", () => {
		expect(
			personalizationCacheWarning(DEFAULT_USER_PERSONALIZATION, {
				...DEFAULT_USER_PERSONALIZATION,
				aboutYou: "Hello",
			})?.description
		).toStartWith("More about you is part of the system prompt");
	});

	test("non-string values read as empty, like Core", () => {
		const corrupt = {
			...DEFAULT_USER_PERSONALIZATION,
			nickname: 42,
			occupation: null,
		} as unknown as typeof DEFAULT_USER_PERSONALIZATION;
		expect(
			changedPersonalizationFields(corrupt, DEFAULT_USER_PERSONALIZATION)
		).toEqual([]);
		expect(
			changedPersonalizationFields(corrupt, {
				...DEFAULT_USER_PERSONALIZATION,
				nickname: "42",
			})
		).toEqual(["Nickname"]);
	});
});
