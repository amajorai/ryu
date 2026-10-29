import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { apiKey } from "@better-auth/api-key";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { bearer, organization } from "better-auth/plugins";
import { z } from "zod";
import type { AuthFixtureDatabase } from "./auth-test-fixtures.ts";

const grants: Array<{ sessionId: string; scope: string; expiresAt: Date }> = [];
mock.module("@ryu/db/models/step-up.model", () => ({
	StepUpAttempt: {},
	StepUpChallenge: {},
	StepUpGrant: {
		findOne: (query: {
			sessionId: string;
			scope: string;
			expiresAt: { $gt: Date };
		}) => ({
			select: () => ({
				lean: async () =>
					grants.find(
						(grant) =>
							grant.sessionId === query.sessionId &&
							grant.scope === query.scope &&
							grant.expiresAt > query.expiresAt.$gt
					) ?? null,
			}),
		}),
	},
}));
mock.module("@ryu/email", () => ({
	StepUpMagicLinkEmail: () => null,
	StepUpOTPEmail: () => null,
	sendEmail: async () => undefined,
}));
const { stepUpGate } = await import("./step-up-plugin.ts");

afterAll(() => mock.restore());
beforeEach(() => {
	grants.length = 0;
});

async function fixture() {
	const database: Pick<
		AuthFixtureDatabase,
		| "user"
		| "session"
		| "account"
		| "verification"
		| "organization"
		| "member"
		| "apikey"
	> = {
		user: [],
		session: [],
		account: [],
		verification: [],
		organization: [],
		member: [],
		apikey: [],
	};
	const auth = betterAuth({
		baseURL: "http://localhost:3000",
		secret: "native-api-key-step-up-test-secret-at-least-32-characters",
		database: memoryAdapter(database),
		emailAndPassword: { enabled: true },
		plugins: [
			bearer(),
			organization(),
			apiKey([
				{ configId: "default", references: "user", enableMetadata: true },
				{
					configId: "organization",
					references: "organization",
					enableMetadata: true,
				},
			]),
			stepUpGate(),
		],
	});
	const signup = await auth.api.signUpEmail({
		body: {
			name: "Owner",
			email: "owner@example.com",
			password: "test-password-1234",
		},
		asResponse: true,
	});
	const body = z
		.object({ user: z.object({ id: z.string() }), token: z.string() })
		.parse(await signup.json());
	const cookie = signup.headers
		.getSetCookie()
		.map((value) => value.split(";")[0])
		.join("; ");
	const sessionId = String(database.session[0]?.id);
	database.organization.push({
		id: "org-1",
		name: "Workspace",
		slug: "workspace",
		createdAt: new Date(),
	});
	database.member.push({
		id: "member-1",
		userId: body.user.id,
		organizationId: "org-1",
		role: "owner",
		createdAt: new Date(),
	});
	const orgKey = await auth.api.createApiKey({
		body: {
			configId: "organization",
			userId: body.user.id,
			organizationId: "org-1",
			name: "Organization key",
		},
	});
	const personalKey = await auth.api.createApiKey({
		body: {
			configId: "default",
			userId: body.user.id,
			name: "Personal key",
			metadata: { ownerType: "org", organizationId: "org-1" },
		},
	});
	return {
		database,
		orgKey,
		personalKey,
		sessionId,
		serverCreate: () =>
			auth.api.createApiKey({
				body: { configId: "default", userId: body.user.id, name: "Server" },
			}),
		serverUpdateOrgKey: () =>
			auth.api.updateApiKey({
				body: {
					configId: "organization",
					keyId: orgKey.id,
					userId: body.user.id,
					enabled: false,
				},
			}),
		create: (transport: "cookie" | "bearer") =>
			auth.handler(
				new Request("http://localhost:3000/api/auth/api-key/create", {
					method: "POST",
					headers: {
						"content-type": "application/json",
						origin: "http://localhost:3000",
						...(transport === "bearer"
							? { authorization: `Bearer ${body.token}` }
							: { cookie }),
					},
					body: JSON.stringify({ name: "Stolen-session key" }),
				})
			),
		read: (
			action: "get" | "list",
			query: Record<string, string>,
			transport: "cookie" | "bearer" = "bearer"
		) =>
			auth.handler(
				new Request(
					`http://localhost:3000/api/auth/api-key/${action}?${new URLSearchParams(query)}`,
					{
						headers: {
							origin: "http://localhost:3000",
							...(transport === "bearer"
								? { authorization: `Bearer ${body.token}` }
								: { cookie }),
						},
					}
				)
			),
		request: (
			action: "delete" | "update",
			keyId: string,
			configId: string | undefined,
			transport: "cookie" | "bearer" = "bearer"
		) =>
			auth.handler(
				new Request(`http://localhost:3000/api/auth/api-key/${action}`, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						origin: "http://localhost:3000",
						...(transport === "bearer"
							? { authorization: `Bearer ${body.token}` }
							: { cookie }),
					},
					body: JSON.stringify({
						keyId,
						configId,
						enabled: action === "update" ? false : undefined,
					}),
				})
			),
	};
}

describe("native organization API key mutations", () => {
	for (const action of ["delete", "update"] as const) {
		for (const transport of ["cookie", "bearer"] as const) {
			it(`refuses a ${transport} client ${action} of an org key even with current proof`, async () => {
				const f = await fixture();
				// Without proof, and with an org.credentials grant: the native endpoint
				// skips the control plane's audit row and spend-cap cleanup either way.
				const rejected = await f.request(
					action,
					f.orgKey.id,
					"organization",
					transport
				);
				expect(rejected.status).toBe(403);
				grants.push({
					sessionId: f.sessionId,
					scope: "org.credentials",
					expiresAt: new Date(Date.now() + 60_000),
				});
				const stillRejected = await f.request(
					action,
					f.orgKey.id,
					"organization",
					transport
				);
				expect(stillRejected.status).toBe(403);
				expect(await stillRejected.json()).toMatchObject({
					message: "Use the organization API keys endpoint",
				});
				expect(
					f.database.apikey.find((key) => key.id === f.orgKey.id)?.enabled
				).toBe(true);
			});
		}
		it(`does not trust the requested config when refusing ${action}`, async () => {
			const f = await fixture();
			grants.push({
				sessionId: f.sessionId,
				scope: "org.credentials",
				expiresAt: new Date(Date.now() + 60_000),
			});
			for (const configId of [undefined, "default", "organization"]) {
				const response = await f.request(action, f.orgKey.id, configId);
				expect(response.status).toBe(403);
				expect(await response.json()).toMatchObject({
					message: "Use the organization API keys endpoint",
				});
			}
			expect(
				f.database.apikey.find((key) => key.id === f.orgKey.id)?.enabled
			).toBe(true);
		});
		it(`still lets a client ${action} its personal key`, async () => {
			const f = await fixture();
			expect(
				(await f.request(action, f.personalKey.id, "default")).status
			).toBe(200);
		});
	}

	it("still lets a server call update an org key", async () => {
		const f = await fixture();
		await f.serverUpdateOrgKey();
		expect(
			f.database.apikey.find((key) => key.id === f.orgKey.id)?.enabled
		).toBe(false);
	});
});

describe("native organization API key reads", () => {
	for (const transport of ["cookie", "bearer"] as const) {
		it(`refuses a ${transport} client list of an org's keys`, async () => {
			const f = await fixture();
			for (const query of [
				{ organizationId: "org-1" } as Record<string, string>,
				{ organizationId: "org-1", configId: "organization" },
			]) {
				const response = await f.read("list", query, transport);
				expect(response.status).toBe(403);
				expect(await response.json()).toMatchObject({
					message: "Use the organization API keys endpoint",
				});
			}
		});

		it(`hides an org key from a ${transport} client get`, async () => {
			const f = await fixture();
			for (const configId of ["organization", "default"]) {
				const response = await f.read(
					"get",
					{ id: f.orgKey.id, configId },
					transport
				);
				expect(response.status).toBe(404);
				expect(await response.json()).toMatchObject({
					code: "KEY_NOT_FOUND",
				});
			}
		});
	}

	it("still lets a client list and get its personal keys", async () => {
		const f = await fixture();
		const list = await f.read("list", { configId: "default" });
		expect(list.status).toBe(200);
		const listed = z
			.object({ apiKeys: z.array(z.object({ id: z.string() })) })
			.parse(await list.json());
		expect(listed.apiKeys.map((key) => key.id)).toEqual([f.personalKey.id]);
		const get = await f.read("get", {
			id: f.personalKey.id,
			configId: "default",
		});
		expect(get.status).toBe(200);
	});
});

describe("native API key creation", () => {
	for (const transport of ["cookie", "bearer"] as const) {
		it(`refuses a ${transport} client mint even with a current step-up`, async () => {
			const f = await fixture();
			const before = f.database.apikey.length;
			// Without proof, and with an org.credentials grant: the native endpoint
			// skips the control plane's scope clamp and audit row either way.
			const rejected = await f.create(transport);
			expect(rejected.status).toBe(403);
			grants.push({
				sessionId: f.sessionId,
				scope: "org.credentials",
				expiresAt: new Date(Date.now() + 60_000),
			});
			const stillRejected = await f.create(transport);
			expect(stillRejected.status).toBe(403);
			expect(await stillRejected.json()).toMatchObject({
				message: "Create API keys from your account settings",
			});
			expect(f.database.apikey).toHaveLength(before);
		});
	}

	it("still lets the control plane mint keys through a server call", async () => {
		const f = await fixture();
		const before = f.database.apikey.length;
		const created = await f.serverCreate();
		expect(created.key).toBeString();
		expect(f.database.apikey).toHaveLength(before + 1);
	});
});
