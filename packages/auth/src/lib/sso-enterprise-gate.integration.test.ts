import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { sso } from "@better-auth/sso";
import { Organization } from "@ryu/db/models/control-plane.model";
import { type BetterAuthOptions, betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { organization } from "better-auth/plugins";
import { z } from "zod";
import { authDatabaseIndexes } from "./database-indexes.ts";
import type { EnterpriseCapability } from "./enterprise-entitlement-policy.ts";
import { resolveEnterpriseSsoUser } from "./sso-enterprise-gate.ts";
import { settleSsoMembership } from "./sso-membership.ts";
import { providerIdFromSsoCallbackPath } from "./sso-organization.ts";
import { encryptedMongoAdapter } from "./sso-provider-encryption.ts";

/**
 * A complete OIDC sign-in through the installed `@better-auth/sso` plugin, with
 * Ryu's `resolveUser` entitlement gate wired the way `index.ts` wires it. The
 * identity provider is a local fake behind `fetch`; nothing leaves the process.
 *
 * - An entitled organization's user signs in. The provider row names the
 *   organization by its hex id (what the adapter writes for this plain string
 *   field); on Mongo, a row holding a BSON ObjectId signs in too.
 * - Once the organization's SSO entitlement is inactive, the same callback is
 *   refused before Better Auth creates a user, account, or session.
 *
 * Always runs on Better Auth's memory adapter. Set `RYU_AUTH_MONGODB_PROOF_URI`
 * (a replica-set URI, for example
 * `mongodb://127.0.0.1:27019/ryu_auth_sso_gate_proof?replicaSet=ryu-api-tests`)
 * to also run it on the production encrypted Mongo adapter; that database is
 * dropped before and after the run.
 */

const BASE_URL = "http://localhost:3000";
const IDP = "https://idp.example.test";
const CLIENT_ID = "ryu-test-client";
const ORGANIZATION_ID = "64c000000000000000000077";
const SECRET = "sso-enterprise-gate-test-secret-long-enough-for-better-auth";
const proofUri = process.env.RYU_AUTH_MONGODB_PROOF_URI;
/** The Mongoose instance `@ryu/db` registers its models on. */
const mongoose = Organization.base;
const { ObjectId } = mongoose.Types;

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
	modulusLength: 2048,
});
const jwk = { ...publicKey.export({ format: "jwk" }), alg: "RS256", kid: "k1" };

function base64url(value: string | Buffer): string {
	return Buffer.from(value).toString("base64url");
}

function idToken(claims: Record<string, unknown>): string {
	const header = base64url(
		JSON.stringify({ alg: "RS256", kid: "k1", typ: "JWT" })
	);
	const payload = base64url(JSON.stringify(claims));
	const signature = sign(
		"RSA-SHA256",
		Buffer.from(`${header}.${payload}`),
		privateKey
	);
	return `${header}.${payload}.${base64url(signature)}`;
}

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

/** Answer the identity provider's token and JWKS endpoints locally. */
function fakeIdentityProvider(email: string): void {
	const fake = async (
		input: Parameters<typeof fetch>[0],
		init?: Parameters<typeof fetch>[1]
	): Promise<Response> => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.origin !== IDP) {
			return await realFetch(input, init);
		}
		if (url.pathname === "/jwks") {
			return Response.json({ keys: [jwk] });
		}
		if (url.pathname === "/token") {
			const now = Math.floor(Date.now() / 1000);
			return Response.json({
				access_token: "idp-access-token",
				expires_in: 3600,
				id_token: idToken({
					aud: CLIENT_ID,
					email,
					email_verified: true,
					exp: now + 600,
					iat: now,
					iss: IDP,
					name: "Alice Example",
					sub: "idp-user-1",
				}),
				token_type: "Bearer",
			});
		}
		return new Response("not found", { status: 404 });
	};
	globalThis.fetch = Object.assign(fake, { preconnect: realFetch.preconnect });
}

interface Store {
	count(model: "account" | "session" | "user"): Promise<number>;
	database: BetterAuthOptions["database"];
	/** Build what the server builds before serving (Mongo only). */
	prepare(options: BetterAuthOptions): Promise<void>;
	/** Rewrite the provider row's organization reference in place. */
	setProviderOrganization(value: unknown): Promise<void>;
	/** True when stored values keep their BSON types (not the memory adapter). */
	storesBson: boolean;
}

function memoryStore(): Store {
	const tables: Record<string, Record<string, unknown>[]> = {
		account: [],
		member: [],
		session: [],
		ssoProvider: [],
		user: [],
		verification: [],
	};
	return {
		count: async (model) => tables[model]?.length ?? 0,
		database: memoryAdapter(tables),
		prepare: async () => undefined,
		setProviderOrganization: async (value) => {
			for (const row of tables.ssoProvider ?? []) {
				row.organizationId = value;
			}
		},
		storesBson: false,
	};
}

async function mongoStore(): Promise<Store> {
	await mongoose.connection.dropDatabase();
	const client = mongoose.connection.getClient();
	const db = mongoose.connection.db ?? client.db();
	return {
		count: async (model) => await db.collection(model).countDocuments(),
		database: encryptedMongoAdapter(db, { client }),
		// The server builds the adapter's indexes at startup (auth-indexes.ts),
		// so its lazy `createIndex` never runs inside the callback transaction.
		prepare: async (options) => {
			for (const index of authDatabaseIndexes(options)) {
				await db.collection(index.collection).createIndex(index.keys, {
					name: index.name,
					unique: index.unique,
				});
			}
		},
		setProviderOrganization: async (value) => {
			await db
				.collection("ssoProvider")
				.updateMany({}, { $set: { organizationId: value } });
		},
		storesBson: true,
	};
}

async function createHarness(store: Store, entitled: () => boolean) {
	const checks: [string, EnterpriseCapability][] = [];
	const auth = betterAuth({
		baseURL: BASE_URL,
		database: store.database,
		plugins: [
			organization(),
			sso({
				domainVerification: { enabled: true },
				organizationProvisioning: { disabled: true },
				provisionUserOnEveryLogin: true,
				resolveUser: async (input, context) =>
					await resolveEnterpriseSsoUser(
						input,
						context.database,
						async (organizationId, capability) => {
							checks.push([organizationId, capability]);
							return entitled();
						}
					),
			}),
		],
		secret: SECRET,
		trustedOrigins: [IDP],
	});
	await store.prepare(auth.options);
	const { adapter } = await auth.$context;
	await adapter.create({
		model: "ssoProvider",
		data: {
			domain: "corp.example",
			domainVerified: true,
			issuer: IDP,
			oidcConfig: JSON.stringify({
				authorizationEndpoint: `${IDP}/authorize`,
				clientId: CLIENT_ID,
				clientSecret: "idp-client-secret",
				jwksEndpoint: `${IDP}/jwks`,
				pkce: true,
				tokenEndpoint: `${IDP}/token`,
			}),
			organizationId: ORGANIZATION_ID,
			providerId: "corp",
		},
	});
	return { auth, checks };
}

const signInSchema = z.object({ url: z.string() });

/** The two calls a sign-in makes, whatever plugins the instance has. */
interface SsoSignInHarness {
	auth: {
		api: {
			signInSSO(input: {
				body: { callbackURL: string; providerId: string };
				returnHeaders: true;
			}): Promise<{ headers: Headers; response: unknown }>;
		};
		handler(request: Request): Promise<Response>;
	};
}

/** Start sign-in, then return from the identity provider to the callback. */
async function signIn(harness: SsoSignInHarness): Promise<Response> {
	const started = await harness.auth.api.signInSSO({
		body: { callbackURL: "/dashboard", providerId: "corp" },
		returnHeaders: true,
	});
	const { url } = signInSchema.parse(started.response);
	const state = new URL(url).searchParams.get("state") ?? "";
	const cookie = started.headers
		.getSetCookie()
		.map((value) => value.split(";")[0])
		.join("; ");
	return await harness.auth.handler(
		new Request(
			`${BASE_URL}/api/auth/sso/callback/corp?code=idp-code&state=${encodeURIComponent(state)}`,
			{ headers: { cookie } }
		)
	);
}

function sessionCookie(response: Response): string | undefined {
	return response.headers
		.getSetCookie()
		.find((value) => value.includes("session_token=") && !value.includes("=;"));
}

const TEST_MASTER_KEY = Buffer.alloc(32, 9).toString("base64");
let originalMasterKey: string | undefined;
beforeAll(async () => {
	if (!proofUri) {
		return;
	}
	// The encrypted adapter seals the provider's client secret.
	originalMasterKey = process.env.RYU_DB_MASTER_KEY;
	process.env.RYU_DB_MASTER_KEY = TEST_MASTER_KEY;
	await mongoose.connect(proofUri, { serverSelectionTimeoutMS: 5000 });
});
afterAll(async () => {
	if (!proofUri) {
		return;
	}
	if (originalMasterKey === undefined) {
		delete process.env.RYU_DB_MASTER_KEY;
	} else {
		process.env.RYU_DB_MASTER_KEY = originalMasterKey;
	}
	await mongoose.connection.dropDatabase();
	await mongoose.disconnect();
});

const variants: [string, () => Promise<Store>, boolean][] = [
	["memory adapter", async () => memoryStore(), true],
	["encrypted Mongo adapter", mongoStore, Boolean(proofUri)],
];

for (const [name, makeStore, enabled] of variants) {
	describe.skipIf(!enabled)(
		`Enterprise SSO entitlement on the OIDC protocol path (${name})`,
		() => {
			it("signs an entitled organization's user in", async () => {
				fakeIdentityProvider("alice@corp.example");
				const store = await makeStore();
				const harness = await createHarness(store, () => true);
				const response = await signIn(harness);

				expect(response.status).toBe(302);
				expect(response.headers.get("location")).toBe("/dashboard");
				expect(sessionCookie(response)).toBeDefined();
				expect(await store.count("session")).toBe(1);
				expect(harness.checks).toEqual([
					[ORGANIZATION_ID, "enterprise.sso.oidc"],
				]);
			});

			it("signs the user in when the provider row stores the organization as an ObjectId", async () => {
				const store = await makeStore();
				if (!store.storesBson) {
					// The memory adapter clones rows, which strips BSON types.
					return;
				}
				fakeIdentityProvider("alice@corp.example");
				const harness = await createHarness(store, () => true);
				await store.setProviderOrganization(new ObjectId(ORGANIZATION_ID));
				const response = await signIn(harness);

				expect(response.status).toBe(302);
				expect(response.headers.get("location")).toBe("/dashboard");
				expect(sessionCookie(response)).toBeDefined();
				expect(harness.checks).toEqual([
					[ORGANIZATION_ID, "enterprise.sso.oidc"],
				]);
			});

			it("refuses the callback once the entitlement is inactive, before any user, account, or session exists", async () => {
				fakeIdentityProvider("alice@corp.example");
				const store = await makeStore();
				let entitled = true;
				const harness = await createHarness(store, () => entitled);
				// The provider and its configuration stay in place; only the
				// entitlement is suspended or expires.
				entitled = false;
				const response = await signIn(harness);

				expect(response.status).toBe(302);
				expect(response.headers.get("location")).toContain(
					"error=ENTERPRISE_SSO_INACTIVE"
				);
				expect(sessionCookie(response)).toBeUndefined();
				expect(await store.count("user")).toBe(0);
				expect(await store.count("account")).toBe(0);
				expect(await store.count("session")).toBe(0);
				expect(harness.checks).toEqual([
					[ORGANIZATION_ID, "enterprise.sso.oidc"],
				]);
			});
		}
	);
}

/**
 * Seat admission for organization-bound SSO
 * (`cloud-auth/organization-membership/sso-seat-admission-bypass`). The
 * organization plugin's `beforeAddMember` hook stands in for Ryu's
 * verified-business and paid-seat gate. Ryu disables the SSO plugin's own
 * provisioning (which writes the member row past that hook) and admits through
 * `settleSsoMembership` and the organization plugin's `addMember` from the
 * global after hook, as `index.ts` does.
 */
describe("SSO organization membership respects the seat gate", () => {
	async function seatHarness(input: {
		pluginProvisioning: boolean;
		seatAvailable: boolean;
	}) {
		const tables: Record<string, Record<string, unknown>[]> = {
			account: [],
			invitation: [],
			member: [],
			organization: [],
			session: [],
			ssoProvider: [],
			user: [],
			verification: [],
		};
		const admissions: string[] = [];
		const options = {
			baseURL: BASE_URL,
			database: memoryAdapter(tables),
			hooks: {
				after: createAuthMiddleware(async (ctx) => {
					const providerId = providerIdFromSsoCallbackPath(
						ctx.path,
						ctx.params
					);
					const created = ctx.context.newSession;
					if (input.pluginProvisioning || !(providerId && created)) {
						return;
					}
					const provider = z.object({ organizationId: z.string() }).parse(
						await ctx.context.adapter.findOne({
							model: "ssoProvider",
							where: [{ field: "providerId", value: providerId }],
						})
					);
					await settleSsoMembership(
						{
							organizationId: provider.organizationId,
							user: { email: created.user.email, id: created.user.id },
						},
						{
							addMember: async (member) => {
								await auth.api.addMember({
									body: { ...member, role: "member" },
								});
							},
							hasPendingInvitation: async () => false,
							isMember: async (member) =>
								Boolean(
									await ctx.context.adapter.findOne({
										model: "member",
										where: [
											{ field: "organizationId", value: member.organizationId },
											{ field: "userId", value: member.userId },
										],
									})
								),
						}
					);
				}),
			},
			plugins: [
				organization({
					organizationHooks: {
						beforeAddMember: async ({ member }) => {
							admissions.push(member.userId);
							if (!input.seatAvailable) {
								throw new APIError("FORBIDDEN", {
									message: "No paid seat is available",
								});
							}
						},
					},
				}),
				sso({
					domainVerification: { enabled: true },
					organizationProvisioning: input.pluginProvisioning
						? { disabled: false, getRole: async () => "member" as const }
						: { disabled: true },
					provisionUserOnEveryLogin: true,
				}),
			],
			secret: SECRET,
			trustedOrigins: [IDP],
		} satisfies BetterAuthOptions;
		const auth = betterAuth(options);
		const { adapter } = await auth.$context;
		await adapter.create({
			data: {
				createdAt: new Date(),
				id: ORGANIZATION_ID,
				name: "Corp",
				slug: "corp",
			},
			forceAllowId: true,
			model: "organization",
		});
		await adapter.create({
			data: {
				domain: "corp.example",
				domainVerified: true,
				issuer: IDP,
				oidcConfig: JSON.stringify({
					authorizationEndpoint: `${IDP}/authorize`,
					clientId: CLIENT_ID,
					clientSecret: "idp-client-secret",
					jwksEndpoint: `${IDP}/jwks`,
					pkce: true,
					tokenEndpoint: `${IDP}/token`,
				}),
				organizationId: ORGANIZATION_ID,
				providerId: "corp",
			},
			model: "ssoProvider",
		});
		return { admissions, harness: { auth }, tables };
	}

	it("the plugin's own provisioning writes a member past the seat gate (why Ryu disables it)", async () => {
		fakeIdentityProvider("alice@corp.example");
		const { admissions, harness, tables } = await seatHarness({
			pluginProvisioning: true,
			seatAvailable: false,
		});
		expect((await signIn(harness)).status).toBe(302);
		expect(admissions).toEqual([]);
		expect(tables.member).toHaveLength(1);
	});

	it("refuses organization membership when no seat is available, and still completes sign-in", async () => {
		fakeIdentityProvider("alice@corp.example");
		const { admissions, harness, tables } = await seatHarness({
			pluginProvisioning: false,
			seatAvailable: false,
		});
		const response = await signIn(harness);
		expect(response.status).toBe(302);
		expect(sessionCookie(response)).toBeDefined();
		expect(admissions).toHaveLength(1);
		expect(tables.member).toHaveLength(0);
	});

	it("admits the user through the seat gate when a seat is available", async () => {
		fakeIdentityProvider("alice@corp.example");
		const { admissions, harness, tables } = await seatHarness({
			pluginProvisioning: false,
			seatAvailable: true,
		});
		expect((await signIn(harness)).status).toBe(302);
		expect(admissions).toHaveLength(1);
		expect(tables.member).toEqual([
			expect.objectContaining({
				organizationId: ORGANIZATION_ID,
				role: "member",
			}),
		]);
	});
});
