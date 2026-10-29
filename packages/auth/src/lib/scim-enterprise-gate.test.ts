import { describe, expect, it } from "bun:test";
import {
	enforceScimEnterpriseAccess,
	type ScimEnterpriseGateDependencies,
	scimManagedTokenDigest,
} from "./scim-enterprise-gate.ts";

// Credentials issued by the installed plugin are covered in
// scim-credential-replacement.integration.test.ts.

const secret = "s".repeat(32);
const token = `ba_scim_credential_${"a".repeat(32)}.${"b".repeat(48)}`;
const digest = scimManagedTokenDigest(secret, token);
const request = (path = "/api/auth/scim/v2/Users", bearer = token) =>
	new Request(`https://example.test${path}`, {
		headers: { authorization: `Bearer ${bearer}` },
		method: "POST",
	});

function dependencies(active: boolean): ScimEnterpriseGateDependencies {
	return {
		credentialHashSecret: secret,
		findCredential: async () => ({
			connectionRecordId: "connection-row",
			expiresAt: new Date("2099-01-01"),
			hashVersion: "v1",
			status: "active",
			tokenDigest: digest,
		}),
		findConnection: async () => ({
			provisioningDomainId: "organization",
			status: "active",
		}),
		hasEnterpriseScim: async () => active,
	};
}

describe("SCIM Enterprise protocol gate", () => {
	it("allows an authenticated managed credential only while its tenant is entitled", async () => {
		expect(
			await enforceScimEnterpriseAccess(request(), dependencies(true))
		).toBe(null);
		const denied = await enforceScimEnterpriseAccess(
			request(),
			dependencies(false)
		);
		expect(denied?.status).toBe(403);
		expect(await denied?.json()).toMatchObject({ status: "403" });
	});

	it("fails closed before entitlement lookup for superseded credentials", async () => {
		let entitlementChecks = 0;
		const deps = dependencies(true);
		deps.findCredential = async () => ({
			connectionRecordId: "connection-row",
			expiresAt: new Date("2099-01-01"),
			hashVersion: "v1",
			status: "revoked",
			tokenDigest: digest,
		});
		deps.hasEnterpriseScim = async () => {
			entitlementChecks += 1;
			return true;
		};
		const denied = await enforceScimEnterpriseAccess(request(), deps);
		expect(denied?.status).toBe(401);
		expect(entitlementChecks).toBe(0);
	});

	it("checks a managed SCIM bearer on any auth path, not only the SCIM prefix", async () => {
		for (const path of [
			"/api/auth//scim/v2/Users",
			"/api/auth/SCIM/v2/Users",
			"/api/auth/scim/v2",
		]) {
			const denied = await enforceScimEnterpriseAccess(
				request(path),
				dependencies(false)
			);
			expect(denied?.status).toBe(403);
		}
	});

	it("refuses an unmanaged bearer on SCIM paths and fails closed on lookup errors", async () => {
		expect(
			(
				await enforceScimEnterpriseAccess(
					request("/api/auth/scim/v2/Users", "static-token"),
					dependencies(true)
				)
			)?.status
		).toBe(401);
		const deps = dependencies(true);
		deps.findCredential = async () => {
			throw new Error("database unavailable");
		};
		expect((await enforceScimEnterpriseAccess(request(), deps))?.status).toBe(
			503
		);
	});

	it("ignores non-SCIM auth traffic", async () => {
		expect(
			await enforceScimEnterpriseAccess(
				new Request("https://example.test/api/auth/get-session"),
				dependencies(false)
			)
		).toBeNull();
		expect(
			await enforceScimEnterpriseAccess(
				request("/api/auth/get-session", "session-token"),
				dependencies(false)
			)
		).toBeNull();
	});
});
