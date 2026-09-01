import { describe, expect, it } from "bun:test";
import { ACCOUNT_LINKING_PROVIDERS } from "./linked-account-providers.ts";

describe("account linking providers", () => {
	it("lists only user-level social identities", () => {
		expect(ACCOUNT_LINKING_PROVIDERS.map((provider) => provider.id)).toEqual([
			"google",
			"github",
			"discord",
		]);
		expect(
			ACCOUNT_LINKING_PROVIDERS.map((provider) => provider.id)
		).not.toContain("telegram");
	});
});
