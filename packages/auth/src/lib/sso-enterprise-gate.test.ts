import { describe, expect, it } from "bun:test";
import { resolveEnterpriseSsoUser } from "./sso-enterprise-gate.ts";

const input = (protocol: "oidc" | "saml") => ({
	protocol,
	providerId: "corp",
	providerReference: {
		providerId: "corp",
		source: { recordId: "provider-row", type: "persisted" as const },
	},
});

describe("Enterprise SSO protocol gate", () => {
	it("checks the exact provider organization and protocol capability", async () => {
		const checks: [string, string][] = [];
		const database = {
			findOne: async () => ({ organizationId: "organization" }),
		};
		expect(
			await resolveEnterpriseSsoUser(
				input("saml"),
				database,
				async (...args) => {
					checks.push(args);
					return true;
				}
			)
		).toEqual({ action: "continue" });
		expect(checks).toEqual([["organization", "enterprise.sso.saml"]]);
	});

	it("accepts an organization stored as an ObjectId and rejects other shapes", async () => {
		const checks: string[] = [];
		const check = async (organizationId: string) => {
			checks.push(organizationId);
			return true;
		};
		const hex = "64c000000000000000000077";
		expect(
			await resolveEnterpriseSsoUser(
				input("oidc"),
				{
					findOne: async () => ({ organizationId: { toHexString: () => hex } }),
				},
				check
			)
		).toEqual({ action: "continue" });
		for (const organizationId of [42, { toHexString: () => "not-hex" }, {}]) {
			expect(
				await resolveEnterpriseSsoUser(
					input("oidc"),
					{ findOne: async () => ({ organizationId }) },
					check
				)
			).toMatchObject({ action: "reject" });
		}
		expect(checks).toEqual([hex]);
	});

	it("fails closed for suspended, missing, configured, and lookup-failed providers", async () => {
		const persisted = input("oidc");
		const cases = [
			resolveEnterpriseSsoUser(
				persisted,
				{ findOne: async () => ({ organizationId: "organization" }) },
				async () => false
			),
			resolveEnterpriseSsoUser(
				persisted,
				{ findOne: async () => null },
				async () => true
			),
			resolveEnterpriseSsoUser(
				{
					...persisted,
					providerReference: {
						providerId: "corp",
						source: { type: "configured" as const },
					},
				},
				{ findOne: async () => ({ organizationId: "organization" }) },
				async () => true
			),
			resolveEnterpriseSsoUser(
				persisted,
				{
					findOne: async () => {
						throw new Error("database unavailable");
					},
				},
				async () => true
			),
		];
		for (const result of await Promise.all(cases)) {
			expect(result).toMatchObject({
				action: "reject",
				code: "ENTERPRISE_SSO_INACTIVE",
			});
		}
	});
});
