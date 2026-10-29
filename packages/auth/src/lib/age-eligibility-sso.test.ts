import { describe, expect, it } from "bun:test";
import { sso } from "@better-auth/sso";
import { type BetterAuthPlugin, betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { createAuthEndpoint } from "better-auth/api";
import { ageEligibilityPlugin } from "./age-eligibility-plugin.ts";
import {
	emailInProviderDomain,
	isOrganizationSsoProvisioning,
	providerIdFromSsoCallbackContext,
} from "./age-eligibility-sso.ts";

interface ProviderRow {
	domain: string;
	domainVerified: boolean;
	id: string;
	organizationId: string | null;
	providerId: string;
}

/**
 * Stands in for the `@better-auth/sso` callbacks: the same provider-specific
 * paths, creating the user through the internal adapter as JIT provisioning
 * does, so the age plugin's database hook sees the real request path. The
 * asserted email comes from the request, as an IdP's would.
 */
function fakeSsoCallbacks(): BetterAuthPlugin {
	const provision = createAuthEndpoint(
		"/sso/callback/:providerId",
		{ method: "GET" },
		async (ctx) => {
			const email =
				new URL(ctx.request?.url ?? "http://localhost").searchParams.get(
					"email"
				) ?? "new.employee@acme.example";
			const user = await ctx.context.internalAdapter.createUser(
				{
					email,
					emailVerified: true,
					name: "New Employee",
				},
				{ method: "sso-oidc", sso: { providerId: ctx.params.providerId } }
			);
			return ctx.json({ id: user.id });
		}
	);
	const acs = createAuthEndpoint(
		"/sso/saml2/sp/acs/:providerId",
		{ method: "POST" },
		async (ctx) => {
			const email =
				new URL(ctx.request?.url ?? "http://localhost").searchParams.get(
					"email"
				) ?? "idp.launch@acme.example";
			const user = await ctx.context.internalAdapter.createUser(
				{
					email,
					emailVerified: true,
					name: "IdP Launch",
				},
				{ method: "sso-saml", sso: { providerId: ctx.params.providerId } }
			);
			return ctx.json({ id: user.id });
		}
	);
	return {
		id: "fake-sso-callbacks",
		schema: {
			ssoProvider: {
				fields: {
					providerId: { type: "string" },
					domain: { type: "string" },
					domainVerified: { type: "boolean", required: false },
					organizationId: { type: "string", required: false },
				},
			},
		},
		endpoints: { provision, acs },
	} satisfies BetterAuthPlugin;
}

function fixture(ssoProvider: ProviderRow[]) {
	const database = {
		user: [] as unknown[],
		session: [] as unknown[],
		account: [] as unknown[],
		verification: [] as unknown[],
		ssoProvider,
	};
	const auth = betterAuth({
		baseURL: "http://localhost:3000",
		secret: "age-eligibility-sso-test-secret-at-least-32-characters",
		database: memoryAdapter(database),
		plugins: [ageEligibilityPlugin(), fakeSsoCallbacks()],
	});
	// No age_eligibility cookie: an IdP POST never carries one.
	const query = (email?: string) =>
		email ? `?email=${encodeURIComponent(email)}` : "";
	const oidcCallback = (providerId: string, email?: string) =>
		auth.handler(
			new Request(
				`http://localhost:3000/api/auth/sso/callback/${providerId}${query(email)}`
			)
		);
	const samlAcs = (providerId: string, email?: string) =>
		auth.handler(
			new Request(
				`http://localhost:3000/api/auth/sso/saml2/sp/acs/${providerId}${query(email)}`,
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Origin: "http://localhost:3000",
					},
					body: "{}",
				}
			)
		);
	return { database, oidcCallback, samlAcs };
}

const provider = (overrides: Partial<ProviderRow> = {}): ProviderRow => ({
	domain: "acme.example",
	domainVerified: true,
	id: "provider-row-acme",
	organizationId: "org-acme",
	providerId: "acme",
	...overrides,
});

describe("age eligibility for organization SSO provisioning", () => {
	it("provisions a first OIDC sign-in in the verified domain without an age cookie", async () => {
		const app = fixture([provider()]);
		expect((await app.oidcCallback("acme", "dev@acme.example")).status).toBe(
			200
		);
		expect(app.database.user).toHaveLength(1);
	});

	it("provisions a first SAML ACS sign-in in the verified domain without an age cookie", async () => {
		const app = fixture([provider()]);
		expect((await app.samlAcs("acme", "ops@eu.acme.example")).status).toBe(200);
		expect(app.database.user).toHaveLength(1);
	});

	it("keeps the age screen for an email outside the verified domain", async () => {
		// A multi-tenant IdP (a public Google client, Entra `common`) asserts
		// whatever account signs in; the organization vouches only for its own.
		const app = fixture([provider()]);
		for (const email of [
			"kid@gmail.com",
			"someone@acme.example.evil.test",
			"someone@notacme.example",
		]) {
			expect((await app.oidcCallback("acme", email)).status).toBe(403);
			expect((await app.samlAcs("acme", email)).status).toBe(403);
		}
		expect(app.database.user).toHaveLength(0);
	});

	it("keeps the age screen for personal providers", async () => {
		const app = fixture([provider({ organizationId: null })]);
		expect((await app.oidcCallback("acme")).status).toBe(403);
		expect((await app.samlAcs("acme")).status).toBe(403);
		expect(app.database.user).toHaveLength(0);
	});

	it("keeps the age screen for unverified provider domains", async () => {
		const app = fixture([provider({ domainVerified: false })]);
		expect((await app.oidcCallback("acme")).status).toBe(403);
		expect(app.database.user).toHaveLength(0);
	});

	it("keeps the age screen for an unknown provider", async () => {
		const app = fixture([provider()]);
		expect((await app.oidcCallback("someone-else")).status).toBe(403);
		expect(app.database.user).toHaveLength(0);
	});
});

describe("isOrganizationSsoProvisioning", () => {
	const employee = { email: "new.employee@acme.example" };
	const contextFor = (path: string, row: unknown, params?: unknown) => {
		const lookups: string[] = [];
		return {
			lookups,
			ctx: {
				path,
				params,
				context: {
					adapter: {
						findOne: ({ where }: { where: { value: string }[] }) => {
							lookups.push(where[0]?.value ?? "");
							return Promise.resolve(row);
						},
					},
				},
			},
		};
	};

	it("accepts only provider-specific SSO callback paths", async () => {
		for (const path of [
			"/sso/callback/acme",
			"/sso/saml2/callback/acme",
			"/sso/saml2/sp/acs/acme",
		]) {
			const { ctx, lookups } = contextFor(path, provider());
			expect(await isOrganizationSsoProvisioning(ctx, employee)).toBe(true);
			expect(lookups).toEqual(["acme"]);
		}
	});

	it("reads the provider id from params on Better Auth route templates", async () => {
		for (const path of [
			"/sso/callback/:providerId",
			"/sso/saml2/callback/:providerId",
			"/sso/saml2/sp/acs/:providerId",
		]) {
			const { ctx, lookups } = contextFor(path, provider(), {
				providerId: "acme",
			});
			expect(await isOrganizationSsoProvisioning(ctx, employee)).toBe(true);
			expect(lookups).toEqual(["acme"]);
		}
		const { ctx, lookups } = contextFor(
			"/sso/callback/:providerId",
			provider()
		);
		expect(await isOrganizationSsoProvisioning(ctx, employee)).toBe(false);
		expect(lookups).toEqual([]);
	});

	it("recognizes the real SSO plugin's provider-specific callback routes", () => {
		const routes = Object.values(
			sso({ domainVerification: { enabled: true } }).endpoints
		).map((endpoint): string | undefined => endpoint.path);
		for (const route of [
			"/sso/callback/:providerId",
			"/sso/saml2/sp/acs/:providerId",
		]) {
			expect(routes).toContain(route);
			expect(
				providerIdFromSsoCallbackContext({
					path: route,
					params: { providerId: "acme" },
				})
			).toBe("acme");
		}
		// The shared callback names its provider only in OAuth state, so it is
		// never exempt (Ryu does not configure `redirectURI`).
		expect(routes).toContain("/sso/callback");
		expect(providerIdFromSsoCallbackContext({ path: "/sso/callback" })).toBe(
			null
		);
	});

	it("never exempts social OAuth or other creation paths", async () => {
		for (const path of [
			"/callback/google",
			"/callback/:id",
			"/oauth2/callback/acme",
			"/sign-up/email",
			"/sso/callback",
			"/sso/register",
		]) {
			const { ctx, lookups } = contextFor(path, provider());
			expect(await isOrganizationSsoProvisioning(ctx, employee)).toBe(false);
			expect(lookups).toEqual([]);
		}
	});

	it("rejects malformed provider rows", async () => {
		for (const row of [
			null,
			{},
			provider({ organizationId: "" }),
			{ ...provider(), domainVerified: "true" },
		]) {
			const { ctx } = contextFor("/sso/callback/acme", row);
			expect(await isOrganizationSsoProvisioning(ctx, employee)).toBe(false);
		}
	});

	it("exempts only an email inside the provider's verified domain", async () => {
		for (const [email, exempt] of [
			["new.employee@acme.example", true],
			["New.Employee@ACME.example", true],
			["engineer@eu.acme.example", true],
			["kid@gmail.com", false],
			["someone@acme.example.evil.test", false],
			["someone@notacme.example", false],
			["no-at-sign", false],
			["", false],
		] as const) {
			const { ctx } = contextFor("/sso/callback/acme", provider());
			expect(await isOrganizationSsoProvisioning(ctx, { email })).toBe(exempt);
		}
	});

	it("never exempts without the user being created", async () => {
		for (const user of [undefined, null, {}, { email: 42 }]) {
			const { ctx, lookups } = contextFor("/sso/callback/acme", provider());
			expect(await isOrganizationSsoProvisioning(ctx, user)).toBe(false);
			expect(lookups).toEqual([]);
		}
		const { ctx } = contextFor("/sso/callback/acme", provider());
		expect(await isOrganizationSsoProvisioning(ctx)).toBe(false);
	});

	it("rejects a provider row without a domain", async () => {
		const { ctx } = contextFor("/sso/callback/acme", {
			...provider(),
			domain: "",
		});
		expect(await isOrganizationSsoProvisioning(ctx, employee)).toBe(false);
	});
});

describe("emailInProviderDomain", () => {
	it("matches comma-separated domains exactly or by subdomain", () => {
		const domains = "acme.example, acme-labs.example";
		expect(emailInProviderDomain("a@acme.example", domains)).toBe(true);
		expect(emailInProviderDomain("a@acme-labs.example", domains)).toBe(true);
		expect(emailInProviderDomain("a@x.acme-labs.example", domains)).toBe(true);
		expect(emailInProviderDomain("a@labs.example", domains)).toBe(false);
		expect(emailInProviderDomain("a@https://acme.example", domains)).toBe(
			false
		);
	});

	it("rejects empty or unparsable domain lists", () => {
		expect(emailInProviderDomain("a@acme.example", "")).toBe(false);
		expect(emailInProviderDomain("a@acme.example", " , ")).toBe(false);
		expect(emailInProviderDomain("a@acme.example", "acme.example,[::")).toBe(
			false
		);
	});
});
