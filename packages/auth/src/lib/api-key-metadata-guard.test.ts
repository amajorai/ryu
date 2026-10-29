import { describe, expect, it } from "bun:test";
import { apiKey } from "@better-auth/api-key";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { bearer, organization } from "better-auth/plugins";
import { z } from "zod";
import { rejectClientApiKeyMetadata } from "./api-key-metadata-guard.ts";
import type { AuthFixtureDatabase } from "./auth-test-fixtures.ts";

const errorBodySchema = z.object({ message: z.string() });

async function fixture({ guarded }: { guarded: boolean }) {
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
		secret: "api-key-metadata-guard-test-secret-at-least-32-characters",
		database: memoryAdapter(database),
		emailAndPassword: { enabled: true },
		hooks: guarded
			? {
					before: createAuthMiddleware(async (ctx) => {
						rejectClientApiKeyMetadata(ctx);
					}),
				}
			: {},
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
	const session = z
		.object({ user: z.object({ id: z.string() }), token: z.string() })
		.parse(await signup.json());
	const clientRequest = (
		action: "create" | "update",
		body: Record<string, unknown>
	) =>
		auth.handler(
			new Request(`http://localhost:3000/api/auth/api-key/${action}`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					origin: "http://localhost:3000",
					authorization: `Bearer ${session.token}`,
				},
				body: JSON.stringify(body),
			})
		);
	return { auth, database, userId: session.user.id, clientRequest };
}

const forgedMetadata = { ownerType: "org", organizationId: "org-victim" };

describe("API key metadata guard", () => {
	it("rejects a client create that carries metadata", async () => {
		const f = await fixture({ guarded: true });
		const response = await f.clientRequest("create", {
			name: "Forged",
			metadata: forgedMetadata,
		});
		expect(response.status).toBe(400);
		expect(errorBodySchema.parse(await response.json()).message).toBe(
			"metadata is server-only"
		);
		expect(f.database.apikey).toHaveLength(0);
	});

	it("is what stops the native plugin from accepting client metadata", async () => {
		const f = await fixture({ guarded: false });
		const response = await f.clientRequest("create", {
			name: "Forged",
			metadata: forgedMetadata,
		});
		expect(response.status).toBe(200);
		expect(f.database.apikey).toHaveLength(1);
	});

	it("rejects a client update that carries metadata", async () => {
		const f = await fixture({ guarded: true });
		const created = await f.auth.api.createApiKey({
			body: {
				configId: "default",
				userId: f.userId,
				name: "Personal",
				metadata: { ownerType: "personal", createdBy: f.userId },
			},
		});
		const before = f.database.apikey.find((key) => key.id === created.id);
		const storedMetadata = before?.metadata;
		const response = await f.clientRequest("update", {
			keyId: created.id,
			configId: "default",
			metadata: forgedMetadata,
		});
		expect(response.status).toBe(400);
		expect(errorBodySchema.parse(await response.json()).message).toBe(
			"metadata is server-only"
		);
		expect(
			f.database.apikey.find((key) => key.id === created.id)?.metadata
		).toEqual(storedMetadata);
	});

	it("allows client creates and updates without metadata", async () => {
		const f = await fixture({ guarded: true });
		const created = await f.clientRequest("create", { name: "Plain" });
		expect(created.status).toBe(200);
		const { id } = z.object({ id: z.string() }).parse(await created.json());
		const updated = await f.clientRequest("update", {
			keyId: id,
			configId: "default",
			name: "Renamed",
		});
		expect(updated.status).toBe(200);
		expect(f.database.apikey.find((key) => key.id === id)?.name).toBe(
			"Renamed"
		);
	});

	it("allows server calls that carry metadata", async () => {
		const f = await fixture({ guarded: true });
		const created = await f.auth.api.createApiKey({
			body: {
				configId: "default",
				userId: f.userId,
				name: "Server minted",
				metadata: { ownerType: "personal", createdBy: f.userId },
			},
		});
		const updated = await f.auth.api.updateApiKey({
			body: {
				keyId: created.id,
				configId: "default",
				userId: f.userId,
				metadata: { ownerType: "personal", tokenType: "fine-grained" },
			},
		});
		expect(updated.metadata).toEqual({
			ownerType: "personal",
			tokenType: "fine-grained",
		});
	});

	it("ignores other paths and treats a null metadata as present", () => {
		const request = new Request("http://localhost:3000/api/auth/api-key/get");
		expect(() =>
			rejectClientApiKeyMetadata({
				path: "/api-key/get",
				request,
				body: { metadata: forgedMetadata },
			})
		).not.toThrow();
		expect(() =>
			rejectClientApiKeyMetadata({
				path: "/api-key/create",
				headers: new Headers(),
				body: { metadata: null },
			})
		).toThrow(APIError);
		expect(() =>
			rejectClientApiKeyMetadata({
				path: "/api-key/update",
				body: { metadata: forgedMetadata },
			})
		).not.toThrow();
		expect(() =>
			rejectClientApiKeyMetadata({
				path: "/api-key/create",
				request,
				body: "not an object",
			})
		).not.toThrow();
	});
});
