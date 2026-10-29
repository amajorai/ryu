import { describe, expect, test } from "bun:test";
import { DEFAULT_USER_PERSONALIZATION } from "@ryuhq/core-client/personalization";
import { personalContextChanged } from "./personal-context.tsx";

const stored = {
	...DEFAULT_USER_PERSONALIZATION,
	nickname: "Fixture",
	occupation: "Engineer",
	aboutYou: "Local context",
	aboutOrganization: "Fixture organization",
};

describe("personalContextChanged", () => {
	test("is false when every field matches the stored value", () => {
		expect(personalContextChanged(stored, { ...stored })).toBe(false);
	});

	test.each([
		"nickname",
		"occupation",
		"aboutYou",
		"aboutOrganization",
	] as const)("is true when %s differs", (key) => {
		expect(
			personalContextChanged(stored, { ...stored, [key]: `${stored[key]}!` })
		).toBe(true);
	});

	test("treats a cleared field as a change", () => {
		expect(personalContextChanged(stored, { ...stored, aboutYou: "" })).toBe(
			true
		);
	});
});
