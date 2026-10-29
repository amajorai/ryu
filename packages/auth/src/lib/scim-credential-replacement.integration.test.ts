import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { scim } from "@better-auth/scim";
import { Organization } from "@ryu/db/models/control-plane.model";
import { type BetterAuthOptions, betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { organization } from "better-auth/plugins";
import { z } from "zod";
import { replaceScimManagedCredential } from "./scim-credential-replacement.ts";
import {
	enforceScimEnterpriseAccess,
	type ScimEnterpriseGateDependencies,
	scimManagedTokenDigest,
} from "./scim-enterprise-gate.ts";
import { encryptedMongoAdapter } from "./sso-provider-encryption.ts";

/**
 * Managed SCIM credentials issued and verified by the installed
 * `@better-auth/scim` plugin, wired the way `index.ts` wires it:
 *
 * - token generation for an existing connection replaces the bearer (the
 *   superseded one stops authenticating SCIM requests) and does so atomically;
 * - the hosted SCIM Enterprise gate accepts exactly the credentials the plugin
 *   accepts, so a plugin change to the token or digest format fails here.
 *
 * Always runs on Better Auth's memory adapter, whose transactions roll back.
 * Set `RYU_AUTH_MONGODB_PROOF_URI` (a replica-set URI, for example
 * `mongodb://127.0.0.1:27019/ryu_auth_scim_replacement_proof?replicaSet=ryu-api-tests`)
 * to also run it on the production Mongo adapter with native transactions; that
 * database is dropped before and after the run.
 */

const SECRET = "scim-replacement-test-secret-long-enough-for-better-auth";
const BASE_URL = "http://localhost:3000";
const ORGANIZATION_ID = "64c000000000000000000042";
const SCOPES = ["scim.users.read", "scim.users.write"] as const;
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const proofUri = process.env.RYU_AUTH_MONGODB_PROOF_URI;
/** The Mongoose instance `@ryu/db` registers its models on. */
const mongoose = Organization.base;

const credentialRowSchema = z.object({
	connectionRecordId: z.unknown(),
	credentialId: z.string(),
	expiresAt: z.date(),
	hashVersion: z.string(),
	status: z.string(),
	tokenDigest: z.string(),
});
const connectionRowSchema = z.object({
	provisioningDomainId: z.string(),
	status: z.string(),
});
const issuedSchema = z.object({
	connection: z.object({ connectionId: z.string() }),
	credential: z.object({ credentialId: z.string() }),
	token: z.string(),
});

function createScimAuth(database: BetterAuthOptions["database"]) {
	return betterAuth({
		baseURL: BASE_URL,
		database,
		plugins: [
			organization(),
			scim({
				connections: [],
				managedConnections: {
					credentialHashSecret: SECRET,
					maxActiveCredentials: 5,
				},
			}),
		],
		secret: SECRET,
	});
}
type ScimAuth = ReturnType<typeof createScimAuth>;

interface Harness {
	auth: ScimAuth;
}

async function memoryHarness(): Promise<Harness> {
	const tables: Record<string, Record<string, unknown>[]> = {};
	const auth = createScimAuth(memoryAdapter(tables));
	for (const table of Object.values((await auth.$context).tables)) {
		tables[table.modelName] ??= [];
	}
	return { auth };
}

async function mongoHarness(): Promise<Harness> {
	const client = mongoose.connection.getClient();
	return {
		auth: createScimAuth(
			encryptedMongoAdapter(mongoose.connection.db ?? client.db(), { client })
		),
	};
}

let sequence = 0;
async function createConnection(auth: ScimAuth) {
	sequence += 1;
	return issuedSchema.parse(
		await auth.api.createSCIMManagedConnection({
			body: {
				actorId: "admin",
				creationRequestId: `ryu-scim-provider-${sequence}-request`,
				expiresAt: new Date(Date.now() + YEAR_MS),
				provisioningDomainId: ORGANIZATION_ID,
				scopes: SCOPES,
			},
		})
	);
}

/** Status Better Auth's own SCIM bearer middleware gives this token. */
async function scimStatus(auth: ScimAuth, token: string): Promise<number> {
	const response = await auth.handler(
		new Request(`${BASE_URL}/api/auth/scim/v2/Users`, {
			headers: { authorization: `Bearer ${token}` },
		})
	);
	return response.status;
}

async function activeCredentialIds(
	auth: ScimAuth,
	connectionId: string
): Promise<string[]> {
	const state = await auth.api.getSCIMManagedConnection({
		body: { connectionId, provisioningDomainId: ORGANIZATION_ID },
	});
	return state.credentials
		.filter((credential) => credential.status === "active")
		.map((credential) => credential.credentialId);
}

async function storedCredentialCount(auth: ScimAuth): Promise<number> {
	const { adapter } = await auth.$context;
	return await adapter.count({ model: "scimManagedCredential" });
}

/** The gate's lookups, read through the same database the plugin wrote. */
function gateDependencies(
	auth: ScimAuth,
	entitled: boolean
): ScimEnterpriseGateDependencies {
	return {
		credentialHashSecret: SECRET,
		findCredential: async (credentialId) => {
			const { adapter } = await auth.$context;
			const row = await adapter.findOne({
				model: "scimManagedCredential",
				where: [{ field: "credentialId", value: credentialId }],
			});
			return row ? credentialRowSchema.parse(row) : null;
		},
		findConnection: async (recordId) => {
			const { adapter } = await auth.$context;
			const row = await adapter.findOne({
				model: "scimManagedConnection",
				where: [{ field: "id", value: String(recordId) }],
			});
			return row ? connectionRowSchema.parse(row) : null;
		},
		hasEnterpriseScim: async (organizationId) =>
			entitled && organizationId === ORGANIZATION_ID,
	};
}

function gateRequest(token: string): Request {
	return new Request(`${BASE_URL}/api/auth/scim/v2/Users`, {
		headers: { authorization: `Bearer ${token}` },
		method: "POST",
	});
}

async function replace(
	auth: ScimAuth,
	connectionId: string,
	api: Parameters<typeof replaceScimManagedCredential>[0]["api"] = auth.api
) {
	return issuedSchema.parse(
		await replaceScimManagedCredential({
			actorId: "admin",
			adapter: (await auth.$context).adapter,
			api,
			connectionId,
			expiresAt: new Date(Date.now() + YEAR_MS),
			provisioningDomainId: ORGANIZATION_ID,
			scopes: SCOPES,
		})
	);
}

beforeAll(async () => {
	if (!proofUri) {
		return;
	}
	await mongoose.connect(proofUri, { serverSelectionTimeoutMS: 5000 });
	await mongoose.connection.dropDatabase();
});
afterAll(async () => {
	if (!proofUri) {
		return;
	}
	await mongoose.connection.dropDatabase();
	await mongoose.disconnect();
});

const variants: [string, () => Promise<Harness>, boolean][] = [
	["memory adapter", memoryHarness, true],
	["Mongo adapter with native transactions", mongoHarness, Boolean(proofUri)],
];

for (const [name, makeHarness, enabled] of variants) {
	describe.skipIf(!enabled)(`managed SCIM credentials (${name})`, () => {
		it("plugin rotation alone keeps the superseded bearer active (the audited behavior)", async () => {
			const { auth } = await makeHarness();
			const original = await createConnection(auth);
			const rotated = issuedSchema.parse(
				await auth.api.rotateSCIMManagedCredential({
					body: {
						actorId: "admin",
						connectionId: original.connection.connectionId,
						expiresAt: new Date(Date.now() + YEAR_MS),
						provisioningDomainId: ORGANIZATION_ID,
						scopes: SCOPES,
					},
				})
			);
			// This is why Ryu must not call rotation on its own.
			expect(await scimStatus(auth, original.token)).toBe(200);
			expect(await scimStatus(auth, rotated.token)).toBe(200);
		});

		it("replacement revokes every superseded bearer and leaves only the new one", async () => {
			const { auth } = await makeHarness();
			const original = await createConnection(auth);
			const { connectionId } = original.connection;
			// A second live bearer, as the earlier additive rotation left behind.
			const extra = issuedSchema.parse(
				await auth.api.rotateSCIMManagedCredential({
					body: {
						actorId: "admin",
						connectionId,
						expiresAt: new Date(Date.now() + YEAR_MS),
						provisioningDomainId: ORGANIZATION_ID,
						scopes: SCOPES,
					},
				})
			);
			const replacement = await replace(auth, connectionId);

			expect(await scimStatus(auth, original.token)).toBe(401);
			expect(await scimStatus(auth, extra.token)).toBe(401);
			expect(await scimStatus(auth, replacement.token)).toBe(200);
			expect(await activeCredentialIds(auth, connectionId)).toEqual([
				replacement.credential.credentialId,
			]);
			// The hosted gate agrees with the plugin on both bearers.
			expect(
				await enforceScimEnterpriseAccess(
					gateRequest(original.token),
					gateDependencies(auth, true)
				).then((response) => response?.status)
			).toBe(401);
			expect(
				await enforceScimEnterpriseAccess(
					gateRequest(replacement.token),
					gateDependencies(auth, true)
				)
			).toBeNull();
		});

		it("rolls the whole replacement back when any step fails", async () => {
			const { auth } = await makeHarness();
			const original = await createConnection(auth);
			const { connectionId } = original.connection;
			const credentialsBefore = await storedCredentialCount(auth);
			let issuedToken = "";
			let reads = 0;
			const failingApi: Parameters<
				typeof replaceScimManagedCredential
			>[0]["api"] = {
				getSCIMManagedConnection: async (input) => {
					reads += 1;
					if (reads === 2) {
						// The final convergence check, after revoke and rotate wrote.
						throw new Error("catalog read failed");
					}
					return await auth.api.getSCIMManagedConnection(input);
				},
				revokeSCIMManagedCredential: async (input) =>
					await auth.api.revokeSCIMManagedCredential(input),
				rotateSCIMManagedCredential: async (input) => {
					const issued = issuedSchema.parse(
						await auth.api.rotateSCIMManagedCredential({
							body: { ...input.body, scopes: SCOPES },
						})
					);
					issuedToken = issued.token;
					return issued;
				},
			};
			await expect(replace(auth, connectionId, failingApi)).rejects.toThrow(
				"catalog read failed"
			);

			expect(issuedToken).not.toBe("");
			// Nothing committed: the previous bearer still works, the replacement
			// never existed, and no credential row was added or revoked.
			expect(await scimStatus(auth, original.token)).toBe(200);
			expect(await scimStatus(auth, issuedToken)).toBe(401);
			expect(await storedCredentialCount(auth)).toBe(credentialsBefore);
			expect(await activeCredentialIds(auth, connectionId)).toEqual([
				original.credential.credentialId,
			]);
		});

		it("replaces a connection that already holds the maximum number of live bearers", async () => {
			const { auth } = await makeHarness();
			const original = await createConnection(auth);
			const { connectionId } = original.connection;
			for (let slot = 1; slot < 5; slot += 1) {
				await auth.api.rotateSCIMManagedCredential({
					body: {
						actorId: "admin",
						connectionId,
						expiresAt: new Date(Date.now() + YEAR_MS),
						provisioningDomainId: ORGANIZATION_ID,
						scopes: SCOPES,
					},
				});
			}
			expect(await activeCredentialIds(auth, connectionId)).toHaveLength(5);
			const replacement = await replace(auth, connectionId);
			expect(await activeCredentialIds(auth, connectionId)).toEqual([
				replacement.credential.credentialId,
			]);
			expect(await scimStatus(auth, original.token)).toBe(401);
			expect(await scimStatus(auth, replacement.token)).toBe(200);
		});

		it("the hosted gate authenticates plugin-issued credentials and enforces the live entitlement", async () => {
			const { auth } = await makeHarness();
			const issued = await createConnection(auth);
			const { adapter } = await auth.$context;
			const stored = credentialRowSchema.parse(
				await adapter.findOne({
					model: "scimManagedCredential",
					where: [
						{ field: "credentialId", value: issued.credential.credentialId },
					],
				})
			);
			// The digest and version the gate computes are the plugin's own.
			expect(stored.hashVersion).toBe("v1");
			expect(scimManagedTokenDigest(SECRET, issued.token)).toBe(
				stored.tokenDigest
			);
			expect(await scimStatus(auth, issued.token)).toBe(200);

			expect(
				await enforceScimEnterpriseAccess(
					gateRequest(issued.token),
					gateDependencies(auth, true)
				)
			).toBeNull();
			const suspended = await enforceScimEnterpriseAccess(
				gateRequest(issued.token),
				gateDependencies(auth, false)
			);
			expect(suspended?.status).toBe(403);
			const tampered = `${issued.token.slice(0, -1)}${
				issued.token.endsWith("A") ? "B" : "A"
			}`;
			expect(await scimStatus(auth, tampered)).toBe(401);
			expect(
				await enforceScimEnterpriseAccess(
					gateRequest(tampered),
					gateDependencies(auth, true)
				).then((response) => response?.status)
			).toBe(401);
		});
	});
}
