import { describe, expect, it } from "bun:test";
import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { verifySelfHostedEnterpriseLicense } from "./enterprise-license.ts";

interface SignedLicenseFixture {
	aud?: string;
	capabilities?: string[];
	exp?: number;
	iat?: number;
	iss?: string;
	licenseId?: string;
	nbf?: number;
	organizationId?: string;
	plan?: string;
	seats?: number | string | null;
}
function encode(
	value: SignedLicenseFixture | { alg: string; typ: string }
): string {
	return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function createLicense(
	privateKey: KeyObject,
	payload: SignedLicenseFixture
): string {
	const header = encode({ alg: "RS256", typ: "JWT" });
	const body = encode(payload);
	const input = `${header}.${body}`;
	const signature = sign("RSA-SHA256", Buffer.from(input), privateKey).toString(
		"base64url"
	);
	return `${input}.${signature}`;
}

describe("verifySelfHostedEnterpriseLicense", () => {
	it("accepts a vendor-signed active license for its organization", () => {
		const { privateKey, publicKey } = generateKeyPairSync("rsa", {
			modulusLength: 2048,
		});
		const token = createLicense(privateKey, {
			aud: "ryu-enterprise",
			capabilities: ["enterprise.scim", "enterprise.sso.oidc"],
			exp: 2_000_000_000,
			iat: 1_900_000_000,
			licenseId: "lic_acme",
			organizationId: "507f1f77bcf86cd799439011",
			plan: "enterprise-plus",
		});

		const license = verifySelfHostedEnterpriseLicense(
			token,
			publicKey.export({ type: "spki", format: "pem" }).toString(),
			new Date(1_950_000_000 * 1000)
		);

		expect(license?.organizationId).toBe("507f1f77bcf86cd799439011");
		expect(license?.plan).toBe("enterprise-plus");
		expect(license?.capabilities).toEqual([
			"enterprise.scim",
			"enterprise.sso.oidc",
		]);
	});

	it("rejects tampered, expired, and wrong-audience licenses", () => {
		const { privateKey, publicKey } = generateKeyPairSync("rsa", {
			modulusLength: 2048,
		});
		const publicKeyPem = publicKey
			.export({ type: "spki", format: "pem" })
			.toString();
		const basePayload = {
			capabilities: ["enterprise.scim"],
			exp: 2_000_000_000,
			organizationId: "507f1f77bcf86cd799439011",
			plan: "enterprise",
		};

		const valid = createLicense(privateKey, basePayload);
		const tokenParts = valid.split(".");
		const header = tokenParts[0] ?? "";
		const signature = tokenParts[2] ?? "";
		const tampered = `${header}.${encode({ ...basePayload, plan: "dedicated" })}.${signature}`;
		const expired = createLicense(privateKey, {
			...basePayload,
			exp: 1_000_000_000,
		});
		const wrongAudience = createLicense(privateKey, {
			...basePayload,
			aud: "other-product",
		});

		expect(
			verifySelfHostedEnterpriseLicense(tampered, publicKeyPem)
		).toBeNull();
		expect(
			verifySelfHostedEnterpriseLicense(
				expired,
				publicKeyPem,
				new Date(1_500_000_000 * 1000)
			)
		).toBeNull();
		expect(
			verifySelfHostedEnterpriseLicense(wrongAudience, publicKeyPem)
		).toBeNull();
	});

	it("reads an optional seat count and ignores a missing or malformed one", () => {
		const { privateKey, publicKey } = generateKeyPairSync("rsa", {
			modulusLength: 2048,
		});
		const publicKeyPem = publicKey
			.export({ type: "spki", format: "pem" })
			.toString();
		const basePayload = {
			capabilities: ["enterprise.scim"],
			exp: 2_000_000_000,
			organizationId: "507f1f77bcf86cd799439011",
			plan: "enterprise",
		};
		const seatsOf = (seats?: number | string | null) =>
			verifySelfHostedEnterpriseLicense(
				createLicense(
					privateKey,
					seats === undefined ? basePayload : { ...basePayload, seats }
				),
				publicKeyPem,
				new Date(1_950_000_000 * 1000)
			);

		expect(seatsOf(25)?.seats).toBe(25);
		expect(seatsOf(1)?.seats).toBe(1);
		// No claim: the license is valid and states no seat count.
		expect(seatsOf()?.seats).toBeNull();
		expect(seatsOf()?.plan).toBe("enterprise");
		// A malformed claim never invalidates the license or sets a count.
		for (const malformed of [0, -3, 2.5, "25", null]) {
			const license = seatsOf(malformed);
			expect(license?.plan).toBe("enterprise");
			expect(license?.seats).toBeNull();
		}
	});

	it("does not let an unsigned seat count through", () => {
		const { privateKey, publicKey } = generateKeyPairSync("rsa", {
			modulusLength: 2048,
		});
		const payload = {
			capabilities: ["enterprise.scim"],
			exp: 2_000_000_000,
			organizationId: "507f1f77bcf86cd799439011",
			plan: "enterprise",
			seats: 5,
		};
		const [header = "", , signature = ""] = createLicense(
			privateKey,
			payload
		).split(".");
		const raised = `${header}.${encode({ ...payload, seats: 500 })}.${signature}`;
		expect(
			verifySelfHostedEnterpriseLicense(
				raised,
				publicKey.export({ type: "spki", format: "pem" }).toString(),
				new Date(1_950_000_000 * 1000)
			)
		).toBeNull();
	});
});
