import { describe, expect, it } from "bun:test";
import {
	ACCOUNT_LINKING_SOCIAL_PROVIDER_IDS,
	isAllowedSocialSignInProvider,
	SOCIAL_SIGN_IN_PROVIDER,
} from "./social-provider-policy.ts";

describe("social provider policy", () => {
	it("keeps account linking user-level and excludes Telegram", () => {
		expect(ACCOUNT_LINKING_SOCIAL_PROVIDER_IDS).toEqual([
			"google",
			"github",
			"discord",
		]);
		expect(ACCOUNT_LINKING_SOCIAL_PROVIDER_IDS).not.toContain("telegram");
	});

	it("allows Google as the only social sign-in provider", () => {
		expect(SOCIAL_SIGN_IN_PROVIDER).toBe("google");
		expect(isAllowedSocialSignInProvider("google")).toBe(true);
		expect(isAllowedSocialSignInProvider("github")).toBe(false);
		expect(isAllowedSocialSignInProvider("discord")).toBe(false);
		expect(isAllowedSocialSignInProvider("telegram")).toBe(false);
		expect(isAllowedSocialSignInProvider(undefined)).toBe(false);
	});
});
