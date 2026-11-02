import { describe, expect, it } from "bun:test";
import {
	assertScimEmailOnVerifiedDomain,
	emailOnVerifiedOrganizationDomain,
	SCIM_EMAIL_DOMAIN_REFUSED,
	scimConnectionOrganizationId,
} from "./scim-email-domain-guard.ts";

describe("emailOnVerifiedOrganizationDomain", () => {
	const verified = [{ domain: "acme.test, @corp.test", domainVerified: true }];

	it("accepts the verified domains and their subdomains", () => {
		expect(emailOnVerifiedOrganizationDomain("ada@acme.test", verified)).toBe(
			true
		);
		expect(
			emailOnVerifiedOrganizationDomain("ada@eu.corp.test", verified)
		).toBe(true);
	});

	it("refuses unrelated, look-alike and unverified domains", () => {
		expect(
			emailOnVerifiedOrganizationDomain("victim@gmail.com", verified)
		).toBe(false);
		expect(
			emailOnVerifiedOrganizationDomain("ada@evilacme.test", verified)
		).toBe(false);
		expect(
			emailOnVerifiedOrganizationDomain("ada@acme.test", [
				{ domain: "acme.test", domainVerified: false },
			])
		).toBe(false);
		expect(emailOnVerifiedOrganizationDomain("ada@acme.test", [])).toBe(false);
		expect(emailOnVerifiedOrganizationDomain(undefined, verified)).toBe(false);
	});
});

describe("scimConnectionOrganizationId", () => {
	it("reads the authenticated connection's organization", () => {
		expect(
			scimConnectionOrganizationId({
				context: { scimConnection: { id: "c", provisioningDomainId: "org" } },
			})
		).toBe("org");
	});

	it("is null without a SCIM connection", () => {
		expect(scimConnectionOrganizationId(null)).toBeNull();
		expect(scimConnectionOrganizationId({ context: {} })).toBeNull();
		expect(
			scimConnectionOrganizationId({
				context: { scimConnection: { provisioningDomainId: "" } },
			})
		).toBeNull();
	});
});

describe("assertScimEmailOnVerifiedDomain", () => {
	it("fails closed when the request carries no SCIM connection", async () => {
		await expect(
			assertScimEmailOnVerifiedDomain("ada@acme.test", null)
		).rejects.toMatchObject({ body: { code: SCIM_EMAIL_DOMAIN_REFUSED } });
	});
});
