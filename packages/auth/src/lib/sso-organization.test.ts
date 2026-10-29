import { describe, expect, it } from "bun:test";
import { providerIdFromSsoCallbackPath } from "./sso-organization.ts";

describe("providerIdFromSsoCallbackPath", () => {
	it("recognizes OIDC and both SAML callback forms", () => {
		expect(providerIdFromSsoCallbackPath("/sso/callback/acme")).toBe("acme");
		expect(
			providerIdFromSsoCallbackPath("/sso/saml2/callback/acme%2Dcorp")
		).toBe("acme-corp");
		expect(providerIdFromSsoCallbackPath("/sso/saml2/sp/acs/acme")).toBe(
			"acme"
		);
	});

	it("reads the provider from the route params when given the hook's route template", () => {
		expect(
			providerIdFromSsoCallbackPath("/sso/callback/:providerId", {
				providerId: "acme",
			})
		).toBe("acme");
		expect(
			providerIdFromSsoCallbackPath("/sso/saml2/sp/acs/:providerId", {
				providerId: "acme",
			})
		).toBe("acme");
		expect(
			providerIdFromSsoCallbackPath("/sso/callback/:providerId")
		).toBeNull();
		expect(
			providerIdFromSsoCallbackPath("/sso/callback/:providerId", {
				providerId: "",
			})
		).toBeNull();
	});

	it("does not infer a provider from shared or unrelated paths", () => {
		expect(providerIdFromSsoCallbackPath("/sso/callback")).toBeNull();
		expect(providerIdFromSsoCallbackPath("/sign-in/email")).toBeNull();
	});
});
