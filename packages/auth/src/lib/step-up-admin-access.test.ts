import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { admin, bearer } from "better-auth/plugins";
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
const {
	platformAdminAccessControl,
	platformAdminRoles,
	protectedAdminUpdateUserFields,
} = await import("./step-up.ts");
const { stepUpGate } = await import("./step-up-plugin.ts");

afterAll(() => mock.restore());
beforeEach(() => {
	grants.length = 0;
});

describe("platformAdminRoles", () => {
	const allowed = (permissions: Record<string, string[]>) =>
		platformAdminRoles.admin.authorize(permissions).success;

	it("grants the admin role only the step-up-gated staff actions", () => {
		for (const action of [
			"ban",
			"delete",
			"impersonate",
			"set-password",
			"set-role",
		]) {
			expect(allowed({ user: [action] })).toBe(true);
		}
	});

	it("never grants session listing, raw updates, creation or admin impersonation", () => {
		// `session:list` returns live session tokens; `user:update` writes the
		// user row raw; `user:create` mints accounts. None is consented,
		// stepped up or audited, so the admin role must not hold them.
		const refused: Record<string, string[]>[] = [
			{ session: ["list"] },
			{ session: ["revoke"] },
			{ session: ["delete"] },
			{ user: ["update"] },
			{ user: ["create"] },
			{ user: ["list"] },
			{ user: ["get"] },
			{ user: ["set-email"] },
			{ user: ["impersonate-admins"] },
		];
		for (const permissions of refused) {
			expect(allowed(permissions)).toBe(false);
		}
	});

	it("grants a plain user nothing", () => {
		for (const action of [
			"ban",
			"delete",
			"impersonate",
			"set-role",
		] as const) {
			expect(
				platformAdminRoles.user.authorize({ user: [action] }).success
			).toBe(false);
		}
		expect(
			platformAdminRoles.user.authorize({ session: ["list"] }).success
		).toBe(false);
	});

	it("is wired into the production admin plugin", () => {
		// Dropping `ac`/`roles` falls back to Better Auth's default admin role,
		// which grants every permission refused above.
		const source = readFileSync(
			new URL("../index.ts", import.meta.url),
			"utf8"
		);
		const adminCall = source.slice(source.indexOf("\t\tadmin({"));
		const options = adminCall.slice(0, adminCall.indexOf("\t\t}),"));
		expect(options).toContain("ac: platformAdminAccessControl,");
		expect(options).toContain("roles: platformAdminRoles,");
		expect(options).not.toContain("adminUserIds");
	});
});

describe("protectedAdminUpdateUserFields", () => {
	it("names every protected field the update would write", () => {
		expect(
			protectedAdminUpdateUserFields({
				userId: "u",
				data: {
					banExpires: null,
					banReason: "x",
					banned: false,
					email: "x@example.com",
					emailVerified: true,
					name: "ok",
					role: "admin",
					twoFactorEnabled: false,
				},
			}).sort()
		).toEqual([
			"banExpires",
			"banReason",
			"banned",
			"email",
			"emailVerified",
			"role",
			"twoFactorEnabled",
		]);
	});

	it("passes profile-only updates and malformed bodies", () => {
		expect(
			protectedAdminUpdateUserFields({ userId: "u", data: { name: "ok" } })
		).toEqual([]);
		expect(protectedAdminUpdateUserFields(null)).toEqual([]);
		expect(protectedAdminUpdateUserFields({ data: "role" })).toEqual([]);
		expect(protectedAdminUpdateUserFields({ role: "admin" })).toEqual([]);
	});
});

async function fixture() {
	const database: Pick<
		AuthFixtureDatabase,
		"user" | "session" | "account" | "verification"
	> = { user: [], session: [], account: [], verification: [] };
	const auth = betterAuth({
		baseURL: "http://localhost:3000",
		secret: "platform-admin-access-test-secret-at-least-32-characters",
		database: memoryAdapter(database),
		emailAndPassword: { enabled: true },
		user: {
			additionalFields: {
				twoFactorEnabled: {
					type: "boolean",
					defaultValue: false,
					input: false,
				},
			},
		},
		plugins: [
			bearer(),
			admin({ ac: platformAdminAccessControl, roles: platformAdminRoles }),
			stepUpGate(),
		],
	});
	const signUp = async (email: string) => {
		const response = await auth.api.signUpEmail({
			body: { name: email, email, password: "test-password-1234" },
			asResponse: true,
		});
		return z
			.object({ user: z.object({ id: z.string() }), token: z.string() })
			.parse(await response.json());
	};
	const operator = await signUp("operator@example.com");
	const target = await signUp("target@example.com");
	const operatorRow = database.user.find((row) => row.id === operator.user.id);
	if (!operatorRow) {
		throw new Error("operator row missing");
	}
	operatorRow.role = "admin";
	operatorRow.twoFactorEnabled = true;
	const operatorSessionId = String(
		database.session.find((row) => row.userId === operator.user.id)?.id
	);
	const targetSessionToken = String(
		database.session.find((row) => row.userId === target.user.id)?.token
	);
	const post = (path: string, payload: Record<string, unknown>) =>
		auth.handler(
			new Request(`http://localhost:3000/api/auth${path}`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					origin: "http://localhost:3000",
					authorization: `Bearer ${operator.token}`,
				},
				body: JSON.stringify(payload),
			})
		);
	return {
		database,
		targetId: target.user.id,
		targetSessionToken,
		grant: () =>
			grants.push({
				sessionId: operatorSessionId,
				scope: "platform.admin",
				expiresAt: new Date(Date.now() + 60_000),
			}),
		post,
		targetRow: () => database.user.find((row) => row.id === target.user.id),
	};
}

describe("Better Auth admin endpoints under the platform admin role", () => {
	it("refuses listing another user's sessions even with a fresh step-up", async () => {
		const f = await fixture();
		f.grant();
		const response = await f.post("/admin/list-user-sessions", {
			userId: f.targetId,
		});
		expect(response.status).toBe(403);
		expect(await response.text()).not.toContain(f.targetSessionToken);
	});

	it("refuses creating a user even with a fresh step-up", async () => {
		const f = await fixture();
		f.grant();
		const before = f.database.user.length;
		const response = await f.post("/admin/create-user", {
			email: "minted@example.com",
			password: "test-password-1234",
			name: "Minted",
		});
		expect(response.status).toBe(403);
		expect(f.database.user).toHaveLength(before);
	});

	it("refuses a raw profile update even with a fresh step-up", async () => {
		const f = await fixture();
		f.grant();
		const response = await f.post("/admin/update-user", {
			userId: f.targetId,
			data: { name: "Renamed" },
		});
		expect(response.status).toBe(403);
		expect(f.targetRow()?.name).toBe("target@example.com");
	});

	it("refuses a raw update carrying a protected field before any permission check", async () => {
		const f = await fixture();
		f.grant();
		const response = await f.post("/admin/update-user", {
			userId: f.targetId,
			data: { role: "admin", email: "taken@example.com" },
		});
		expect(response.status).toBe(403);
		expect(await response.text()).toContain(
			"Change email, role through its own endpoint"
		);
		expect(f.targetRow()?.role).not.toBe("admin");
		expect(f.targetRow()?.email).toBe("target@example.com");
	});

	it("requires a step-up for a granted action, then performs it", async () => {
		const f = await fixture();
		const refused = await f.post("/admin/ban-user", { userId: f.targetId });
		expect(refused.status).toBe(403);
		expect(await refused.json()).toMatchObject({
			code: "STEP_UP_REQUIRED",
			scope: "platform.admin",
		});
		expect(f.targetRow()?.banned).not.toBe(true);
		f.grant();
		const banned = await f.post("/admin/ban-user", { userId: f.targetId });
		expect(banned.status).toBe(200);
		expect(f.targetRow()?.banned).toBe(true);
	});

	it("still lets a stepped-up admin set a role", async () => {
		const f = await fixture();
		f.grant();
		const response = await f.post("/admin/set-role", {
			userId: f.targetId,
			role: "admin",
		});
		expect(response.status).toBe(200);
		expect(f.targetRow()?.role).toBe("admin");
	});
});
