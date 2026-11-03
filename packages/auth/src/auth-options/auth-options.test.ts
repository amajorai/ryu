import { afterAll, describe, expect, it, mock } from "bun:test";

/**
 * `index.ts` composes `auth` from the modules in this directory. These tests
 * pin the composition contracts the split has to keep: plugin order (hooks run
 * in that order), every organization hook reaching the plugin exactly once, the
 * options each module contributes, and the `auth.api` registry the hooks read.
 * Only the Mongo driver is stubbed; no collection holds any rows.
 */
Object.assign(process.env, {
	BETTER_AUTH_SECRET: "auth-options-composition-".repeat(3),
	BETTER_AUTH_URL: "http://localhost:3000",
	DATABASE_URL: "mongodb://127.0.0.1:1/unused-auth-options-fixture",
	NODE_ENV: "test",
	POLAR_ACCESS_TOKEN: "local-test",
	POLAR_BILLING_AUTHORITY: "local",
	POLAR_SERVER: "sandbox",
	POLAR_SUCCESS_URL: "http://localhost:3001/success",
	RYU_DB_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
	RYU_DIR: "/tmp/ryu-dev-headless",
	RYU_KEYCHAIN: "off",
	RYU_PROFILE: "dev",
});

function emptyCursor() {
	const chain = {
		limit: () => chain,
		next: async () => null,
		project: () => chain,
		skip: () => chain,
		sort: () => chain,
		toArray: async () => [],
		async *[Symbol.asyncIterator]() {
			// No rows.
		},
	};
	return chain;
}

function collection() {
	return new Proxy(
		{},
		{
			get: (_target, method) => {
				if (method === "find" || method === "aggregate") {
					return () => emptyCursor();
				}
				if (method === "insertOne") {
					return async () => ({ acknowledged: true, insertedId: "fixture" });
				}
				return async () => null;
			},
		}
	);
}
mock.module("@ryu/db", () => ({ client: { collection }, mongoClient: {} }));

// Read the registry before `index.ts` has created `auth`.
const { authApi } = await import("./auth-instance.ts");
let apiBeforeRegistration: unknown = null;
try {
	authApi();
} catch (error) {
	apiBeforeRegistration = error;
}

const {
	auth,
	finalizeCanceledOrganizationInvitation,
	organizationSeatPathForTests,
} = await import("../index.ts");
const { baseAuthOptions } = await import("./base-options.ts");
const { emailAuthOptions } = await import("./email-options.ts");
const { beforeAuthHook } = await import("./before-hook.ts");
const { afterAuthHook } = await import("./after-hook.ts");
const { databaseHooks } = await import("./database-hooks.ts");
const { signInPlugins } = await import("./sign-in-plugins.ts");
const { accountSessionPlugins, deviceSessionPlugins } = await import(
	"./session-plugins.ts"
);
const { jwtPlugins } = await import("./jwt-plugin.ts");
const { oauthPlugins } = await import("./oauth-plugins.ts");
const { organizationPlugin } = await import("./organization-plugin.ts");
const { organizationLifecycleHooks } = await import(
	"./organization-lifecycle-hooks.ts"
);
const { organizationMemberHooks } = await import(
	"./organization-member-hooks.ts"
);
const { organizationInvitationHooks } = await import(
	"./organization-invitation-hooks.ts"
);
const { organizationTeamHooks } = await import("./organization-team-hooks.ts");
const admission = await import("./admission.ts");
const seatClaims = await import("./seat-claims.ts");
const seatCapacity = await import("./seat-capacity.ts");
const schemas = await import("./schemas.ts");
const origins = await import("./origins.ts");
const emailRateLimit = await import("./email-rate-limit.ts");
const invitationPolicy = await import("./invitation-policy.ts");
const invitationEmails = await import("./invitation-emails.ts");
const memberGrants = await import("./member-grants.ts");
const loginActivity = await import("./login-activity.ts");
const identityPlugins = await import("./identity-plugins.ts");
const teamClaims = await import("./team-claims.ts");

afterAll(() => {
	mock.restore();
});

const ids = (plugins: readonly { id: string }[]) =>
	plugins.map((plugin) => plugin.id);

describe("auth composition", () => {
	it("registers auth.api for hooks only once auth exists", () => {
		expect(apiBeforeRegistration).toBeInstanceOf(Error);
		expect(authApi()).toBe(auth.api);
	});

	it("keeps the plugin order the before-hooks depend on", () => {
		const pluginIds = ids(auth.options.plugins);
		expect(pluginIds[0]).toBe("ryu-admin-abuse-guard");
		expect(pluginIds.at(-1)).toBe("ryu-step-up");
		expect(pluginIds.indexOf("ryu-banned-sign-in")).toBeLessThan(
			pluginIds.indexOf("admin")
		);
		expect(pluginIds.indexOf("bearer")).toBeLessThan(
			pluginIds.indexOf("ryu-step-up")
		);
		expect(pluginIds.slice(0, -5)).toEqual([
			...ids(signInPlugins),
			...ids(deviceSessionPlugins),
			"bearer",
			...ids(accountSessionPlugins),
			...ids(jwtPlugins),
			...ids(oauthPlugins),
			organizationPlugin.id,
		]);
		expect(new Set(pluginIds).size).toBe(pluginIds.length);
	});

	it("installs each module's options and hooks", () => {
		expect(auth.options.hooks?.before).toBe(beforeAuthHook);
		expect(auth.options.hooks?.after).toBe(afterAuthHook);
		expect(auth.options.databaseHooks).toBe(databaseHooks);
		expect(auth.options.emailAndPassword).toBe(
			emailAuthOptions.emailAndPassword
		);
		expect(auth.options.emailVerification).toBe(
			emailAuthOptions.emailVerification
		);
		expect(auth.options.rateLimit).toBe(baseAuthOptions.rateLimit);
		expect(auth.options.user).toBe(baseAuthOptions.user);
	});

	it("hands every organization hook to the plugin exactly once", () => {
		const modules = [
			organizationLifecycleHooks,
			organizationMemberHooks,
			organizationInvitationHooks,
			organizationTeamHooks,
		];
		const names = modules.flatMap((hooks) => Object.keys(hooks));
		// A name defined in two modules would silently drop one implementation.
		expect(new Set(names).size).toBe(names.length);
		const installed = organizationPlugin.options?.organizationHooks ?? {};
		expect(Object.keys(installed).sort()).toEqual([...names].sort());
		for (const hooks of modules) {
			for (const [name, hook] of Object.entries(hooks)) {
				expect(installed[name as keyof typeof installed]).toBe(hook);
			}
		}
		expect(names).toContain("beforeCreateOrganization");
		expect(names).toContain("afterDeleteOrganization");
	});

	it("keeps the invitation expiry and seat claim on one contract", () => {
		expect(seatCapacity.ORGANIZATION_INVITATION_EXPIRES_IN_SEC).toBe(
			48 * 60 * 60
		);
		expect(organizationPlugin.options?.invitationExpiresIn).toBe(
			seatCapacity.ORGANIZATION_INVITATION_EXPIRES_IN_SEC
		);
		expect(organizationSeatPathForTests).toBe(
			seatClaims.organizationSeatPathForTests
		);
		expect(finalizeCanceledOrganizationInvitation).toBe(
			admission.finalizeCanceledOrganizationInvitation
		);
	});
});

describe("auth option helpers", () => {
	it("derives seat claim ids from the normalized recipient", () => {
		expect(
			seatCapacity.pendingInvitationClaimId("org-1", "Person@Example.com")
		).toBe(
			seatCapacity.pendingInvitationClaimId("org-1", "person@example.com")
		);
		expect(
			seatCapacity.pendingInvitationClaimId("org-1", "person@example.com")
		).not.toBe(
			seatCapacity.pendingInvitationClaimId("org-2", "person@example.com")
		);
		expect(seatCapacity.directMemberClaimId("user-1")).toBe(
			"direct_member:user-1"
		);
		expect(
			invitationPolicy.invitationCreationKey("org-1", "Person@Example.com")
		).toBe(
			invitationPolicy.invitationCreationKey("org-1", "person@example.com")
		);
	});

	it("narrows driver and Better Auth errors without casts", () => {
		expect(invitationPolicy.isDuplicateKeyError({ code: 11_000 })).toBe(true);
		expect(invitationPolicy.isDuplicateKeyError({ code: 11_001 })).toBe(false);
		expect(invitationPolicy.isDuplicateKeyError("boom")).toBe(false);
		expect(schemas.errorCode({ code: "RATE_LIMIT_EXCEEDED" })).toBe(
			"RATE_LIMIT_EXCEEDED"
		);
		expect(schemas.errorCode(new Error("no code"))).toBeUndefined();
		expect(emailRateLimit.retryAfterSeconds({ retryAfter: 42 })).toBe(42);
		expect(emailRateLimit.retryAfterSeconds("nope")).toBeUndefined();
		expect(invitationEmails.returnedInvitationId({ id: "inv-1" })).toBe(
			"inv-1"
		);
		expect(invitationEmails.returnedInvitationId({ id: "" })).toBeNull();
		expect(
			memberGrants.leftMemberSchema.safeParse({ organizationId: "o" }).success
		).toBe(false);
	});

	it("parses comma-separated environment lists", () => {
		expect(origins.parseCsvEnv(" a , ,b,")).toEqual(["a", "b"]);
		expect(origins.parseCsvEnv(undefined)).toEqual([]);
	});

	it("leaves Turnstile off in a test run without a secret", () => {
		expect(loginActivity.TURNSTILE_SECRET_KEY).toBeNull();
		expect(loginActivity.TURNSTILE_CAPTCHA_ENABLED).toBe(false);
		expect(ids(signInPlugins)).not.toContain("captcha");
	});

	it("builds the passkey and SCIM plugins Ryu installs", () => {
		expect(identityPlugins.createRyuPasskeyPlugin().id).toBe("passkey");
		expect(identityPlugins.createRyuScimPlugin().id).toBe("scim");
	});

	it("resolves no team claims for a user without teams", async () => {
		expect(await teamClaims.resolveTeamClaims("user-1", [], [])).toEqual([]);
	});
});
