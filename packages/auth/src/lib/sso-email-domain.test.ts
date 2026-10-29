import { describe, expect, it } from "bun:test";
import type { BetterAuthPlugin } from "better-auth";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { createAuthEndpoint } from "better-auth/api";
import { handleOAuthUserInfo } from "better-auth/oauth2";
import { z } from "zod";
import {
	emailOnProviderDomain,
	SSO_DOMAIN_UNVERIFIED,
	SSO_EMAIL_DOMAIN_MISMATCH,
	type SsoIdentityStore,
	validateSsoIdentityDomain,
	validateSsoIdentityUserInfo,
} from "./sso-email-domain.ts";

const SECRET = "sso-email-domain-test-secret-0123456789abcdef";

function store(
	providers: Record<string, { domain: string; domainVerified: boolean }>,
	users: Record<string, string> = {}
): SsoIdentityStore {
	return {
		findProvider: async (providerId) => providers[providerId] ?? null,
		findUserEmail: async (userId) => users[userId] ?? null,
	};
}

const ACME = { acme: { domain: "acme.com, acme.io", domainVerified: true } };

describe("emailOnProviderDomain", () => {
	it("matches the domain, its subdomains, and every listed domain", () => {
		expect(emailOnProviderDomain("Ada@Acme.com", "acme.com")).toBe(true);
		expect(emailOnProviderDomain("ada@eu.acme.com", "acme.com")).toBe(true);
		expect(emailOnProviderDomain("ada@acme.io", "acme.com, acme.io")).toBe(
			true
		);
	});

	it("refuses other domains, look-alikes, and malformed input", () => {
		expect(emailOnProviderDomain("ada@notacme.com", "acme.com")).toBe(false);
		expect(emailOnProviderDomain("ada@acme.com.evil.io", "acme.com")).toBe(
			false
		);
		expect(emailOnProviderDomain("admin@ryu.example", "acme.com")).toBe(false);
		expect(emailOnProviderDomain("no-at-sign", "acme.com")).toBe(false);
		// Better Auth reads the text after the FIRST "@"; so does this gate.
		expect(emailOnProviderDomain("x@evil.com@acme.com", "acme.com")).toBe(
			false
		);
		expect(emailOnProviderDomain("ada@acme.com", "")).toBe(false);
		expect(emailOnProviderDomain(null, "acme.com")).toBe(false);
	});
});

describe("validateSsoIdentityDomain", () => {
	const sso = (action: string, providerId: string | null = "acme") => ({
		action,
		method: "sso-oidc",
		sso: providerId ? { providerId } : null,
	});

	it("lets an SSO provider create an account on its verified domain", async () => {
		expect(
			await validateSsoIdentityDomain(
				{ source: sso("create-user"), user: { email: "ada@acme.com" } },
				store(ACME)
			)
		).toBeUndefined();
	});

	it("refuses to create an account outside the provider's verified domain", async () => {
		expect(
			await validateSsoIdentityDomain(
				{
					source: { ...sso("create-user"), method: "sso-saml" },
					user: { email: "admin@ryu.example" },
				},
				store(ACME)
			)
		).toMatchObject({ error: SSO_EMAIL_DOMAIN_MISMATCH });
	});

	it("fails closed on a missing or unverified provider", async () => {
		const input = (providerId: string | null) => ({
			source: sso("create-user", providerId),
			user: { email: "ada@acme.com" },
		});
		expect(await validateSsoIdentityDomain(input(null), store(ACME))).toEqual(
			expect.objectContaining({ error: SSO_DOMAIN_UNVERIFIED })
		);
		expect(
			await validateSsoIdentityDomain(input("missing"), store(ACME))
		).toEqual(expect.objectContaining({ error: SSO_DOMAIN_UNVERIFIED }));
		expect(
			await validateSsoIdentityDomain(
				input("acme"),
				store({ acme: { domain: "acme.com", domainVerified: false } })
			)
		).toEqual(expect.objectContaining({ error: SSO_DOMAIN_UNVERIFIED }));
	});

	it("refuses link and sign-in when the STORED address left the domain", async () => {
		const users = { "u-ada": "ada@acme.com", "u-moved": "admin@ryu.example" };
		for (const action of ["link-account", "sign-in"]) {
			expect(
				await validateSsoIdentityDomain(
					{ source: sso(action), user: { email: "ada@acme.com", id: "u-ada" } },
					store(ACME, users)
				)
			).toBeUndefined();
			expect(
				await validateSsoIdentityDomain(
					{
						source: sso(action),
						user: { email: "ada@acme.com", id: "u-moved" },
					},
					store(ACME, users)
				)
			).toMatchObject({ error: SSO_EMAIL_DOMAIN_MISMATCH });
			expect(
				await validateSsoIdentityDomain(
					{ source: sso(action), user: { email: "ada@acme.com" } },
					store(ACME, users)
				)
			).toMatchObject({ error: SSO_EMAIL_DOMAIN_MISMATCH });
		}
	});

	it("leaves non-SSO sources alone", async () => {
		for (const method of ["oauth", "email-password", "magic-link", "scim"]) {
			expect(
				await validateSsoIdentityDomain(
					{
						source: { action: "create-user", method },
						user: { email: "admin@ryu.example" },
					},
					store({})
				)
			).toBeUndefined();
		}
	});
});

/**
 * Drive Better Auth's real provider-login seam (`handleOAuthUserInfo`, which
 * the SSO plugin's OIDC and SAML callbacks call with an `sso-*` source) with
 * the production `validateUserInfo`, so the gate is proven where an SSO
 * callback would create, link, or sign in an account.
 */
function ssoFixture() {
	const database: Record<string, Record<string, unknown>[]> = {
		account: [],
		session: [],
		ssoProvider: [
			{
				domain: "acme.com",
				domainVerified: true,
				id: "p-acme",
				providerId: "acme",
			},
		],
		user: [],
		verification: [],
	};
	const callbackProbe = {
		id: "sso-callback-probe",
		schema: {
			ssoProvider: {
				fields: {
					domain: { type: "string", required: true },
					domainVerified: { type: "boolean", required: false },
					providerId: { type: "string", required: true },
				},
			},
		},
		endpoints: {
			ssoCallbackProbe: createAuthEndpoint(
				"/sso-callback-probe",
				{
					method: "POST",
					body: z.object({ accountId: z.string(), email: z.string() }),
				},
				async (ctx) => {
					const result = await handleOAuthUserInfo(ctx, {
						account: {
							accessToken: "",
							accountId: ctx.body.accountId,
							issuer: "https://idp.acme.com",
							providerId: "acme",
							refreshToken: "",
						},
						callbackURL: "http://localhost:3000",
						isTrustedProvider: emailOnProviderDomain(
							ctx.body.email,
							"acme.com"
						),
						source: { method: "sso-oidc", sso: { providerId: "acme" } },
						trustProviderByName: false,
						userInfo: {
							email: ctx.body.email,
							emailVerified: false,
							id: ctx.body.accountId,
							name: "SSO user",
						},
					});
					return ctx.json({
						error: result.error ?? null,
						userId: result.data?.user.id ?? null,
					});
				}
			),
		},
	} satisfies BetterAuthPlugin;
	const auth = betterAuth({
		baseURL: "http://localhost:3000",
		database: memoryAdapter(database),
		plugins: [callbackProbe],
		secret: SECRET,
		user: { validateUserInfo: validateSsoIdentityUserInfo },
	});
	return { auth, database };
}

describe("SSO callback through Better Auth's validateUserInfo", () => {
	it("creates and signs in an account on the provider's verified domain", async () => {
		const { auth, database } = ssoFixture();
		const result = await auth.api.ssoCallbackProbe({
			body: { accountId: "idp-ada", email: "ada@acme.com" },
		});
		expect(result.error).toBeNull();
		expect(result.userId).toBeString();
		expect(database.user?.map((user) => user.email)).toEqual(["ada@acme.com"]);
		expect(database.session).toHaveLength(1);
	});

	it("rejects an SSO callback for an email outside the provider's domain and creates nothing", async () => {
		const { auth, database } = ssoFixture();
		await expect(
			auth.api.ssoCallbackProbe({
				body: { accountId: "idp-squat", email: "admin@ryu.example" },
			})
		).rejects.toMatchObject({
			body: { code: SSO_EMAIL_DOMAIN_MISMATCH },
			statusCode: 403,
		});
		expect(database.user).toHaveLength(0);
		expect(database.account).toHaveLength(0);
		expect(database.session).toHaveLength(0);
	});

	it("refuses an SSO sign-in once the linked account's stored address left the domain", async () => {
		const { auth, database } = ssoFixture();
		const created = await auth.api.ssoCallbackProbe({
			body: { accountId: "idp-ada", email: "ada@acme.com" },
		});
		const stored = database.user?.find((user) => user.id === created.userId);
		if (!stored) {
			throw new Error("SSO user was not created");
		}
		// The address moves off the domain (for example a directory rename to an
		// allowlisted address); the IdP still asserts the in-domain address.
		stored.email = "admin@ryu.example";
		await expect(
			auth.api.ssoCallbackProbe({
				body: { accountId: "idp-ada", email: "ada@acme.com" },
			})
		).rejects.toMatchObject({
			body: { code: SSO_EMAIL_DOMAIN_MISMATCH },
			statusCode: 403,
		});
		expect(database.session).toHaveLength(1);
	});
});
