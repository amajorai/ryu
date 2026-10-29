import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { admin, bearer } from "better-auth/plugins";
import type { AuthFixtureDatabase } from "./auth-test-fixtures.ts";

interface AuditRow {
	action: string;
	actorId: string | null;
	actorType: string;
	details: Record<string, unknown>;
	organizationId: string;
	target: string;
	targetId: string | null;
}

const audits: AuditRow[] = [];
let failAuditWrites = false;

mock.module("@ryu/db/models/control-audit.model", () => ({
	CONTROL_AUDIT_ACTOR_TYPES: ["user", "gateway", "system"],
	ControlAuditEvent: {
		create: async (row: AuditRow) => {
			if (failAuditWrites) {
				throw new Error("audit store unavailable");
			}
			audits.push(row);
			return row;
		},
	},
	PLATFORM_CONTROL_AUDIT_ORGANIZATION_ID: "platform",
}));

const { platformAdminAuditPlugin } = await import(
	"./platform-admin-audit-plugin.ts"
);

const SECRET = "platform-admin-audit-test-secret-at-least-32-characters";
const PASSWORD = "a-strong-test-password";
const NEW_PASSWORD = "another-strong-test-password";

async function fixture() {
	const database: Pick<
		AuthFixtureDatabase,
		"account" | "session" | "user" | "verification"
	> = { account: [], session: [], user: [], verification: [] };
	const auth = betterAuth({
		baseURL: "http://localhost:3000",
		database: memoryAdapter(database),
		emailAndPassword: { enabled: true },
		secret: SECRET,
		plugins: [bearer(), admin(), platformAdminAuditPlugin()],
	});
	const operator = (
		await auth.api.createUser({
			body: {
				email: "operator@example.com",
				name: "Operator",
				password: PASSWORD,
				role: "admin",
			},
		})
	).user;
	const target = (
		await auth.api.createUser({
			body: {
				email: "customer@example.com",
				name: "Customer",
				password: PASSWORD,
			},
		})
	).user;
	const operatorSignIn = await auth.api.signInEmail({
		body: { email: "operator@example.com", password: PASSWORD },
	});
	const targetSignIn = await auth.api.signInEmail({
		body: { email: "customer@example.com", password: PASSWORD },
	});
	audits.length = 0;
	return {
		auth,
		operator,
		operatorHeaders: new Headers({
			authorization: `Bearer ${operatorSignIn.token}`,
		}),
		target,
		targetHeaders: new Headers({
			authorization: `Bearer ${targetSignIn.token}`,
		}),
		targetToken: targetSignIn.token,
	};
}

beforeEach(() => {
	audits.length = 0;
	failAuditWrites = false;
});

afterAll(() => {
	mock.restore();
});

describe("platform admin audit", () => {
	it("records who granted a role, to whom, and the role it replaced", async () => {
		const f = await fixture();
		await f.auth.api.setRole({
			body: { role: "admin", userId: f.target.id },
			headers: f.operatorHeaders,
		});
		expect(audits).toEqual([
			{
				action: "platform.user.role.set",
				actorId: f.operator.id,
				actorType: "user",
				details: {
					method: "POST",
					priorRole: "user",
					role: "admin",
					status: "success",
				},
				organizationId: "platform",
				target: "user",
				targetId: f.target.id,
			},
		]);
	});

	it("refuses a non-admin role change and records nothing", async () => {
		const f = await fixture();
		await expect(
			f.auth.api.setRole({
				body: { role: "admin", userId: f.target.id },
				headers: f.targetHeaders,
			})
		).rejects.toMatchObject({
			body: { code: "YOU_ARE_NOT_ALLOWED_TO_CHANGE_USERS_ROLE" },
			status: "FORBIDDEN",
			statusCode: 403,
		});
		expect(audits).toEqual([]);
	});

	it("never stores the password, ban reason, session token or new field values", async () => {
		const f = await fixture();
		// Before the ban, which ends every session the target holds.
		await f.auth.api.revokeUserSession({
			body: { sessionToken: f.targetToken },
			headers: f.operatorHeaders,
		});
		await f.auth.api.setUserPassword({
			body: { newPassword: NEW_PASSWORD, userId: f.target.id },
			headers: f.operatorHeaders,
		});
		await f.auth.api.banUser({
			body: {
				banExpiresIn: 3600,
				banReason: "private moderation note",
				userId: f.target.id,
			},
			headers: f.operatorHeaders,
		});
		await f.auth.api.unbanUser({
			body: { userId: f.target.id },
			headers: f.operatorHeaders,
		});
		await f.auth.api.adminUpdateUser({
			body: { data: { name: "Renamed Customer" }, userId: f.target.id },
			headers: f.operatorHeaders,
		});
		await f.auth.api.revokeUserSessions({
			body: { userId: f.target.id },
			headers: f.operatorHeaders,
		});

		expect(audits.map((row) => row.action)).toEqual([
			"platform.user.session.revoke",
			"platform.user.password.set",
			"platform.user.ban",
			"platform.user.unban",
			"platform.user.update",
			"platform.user.sessions.revoke",
		]);
		for (const row of audits) {
			expect(row.actorId).toBe(f.operator.id);
			expect(row.targetId).toBe(f.target.id);
		}
		expect(audits[2]?.details.banExpiresIn).toBe(3600);
		expect(audits[4]?.details.fields).toEqual(["name"]);
		const serialized = JSON.stringify(audits);
		for (const secret of [
			NEW_PASSWORD,
			"private moderation note",
			"Renamed Customer",
			f.targetToken,
		]) {
			expect(serialized).not.toContain(secret);
		}
	});

	it("records created and removed accounts by id", async () => {
		const f = await fixture();
		const created = await f.auth.api.createUser({
			body: {
				email: "new-admin@example.com",
				name: "New Admin",
				password: PASSWORD,
				role: "admin",
			},
			headers: f.operatorHeaders,
		});
		await f.auth.api.removeUser({
			body: { userId: f.target.id },
			headers: f.operatorHeaders,
		});
		expect(audits).toMatchObject([
			{
				action: "platform.user.create",
				actorId: f.operator.id,
				details: { role: "admin" },
				targetId: created.user.id,
			},
			{
				action: "platform.user.remove",
				actorId: f.operator.id,
				targetId: f.target.id,
			},
		]);
		expect(JSON.stringify(audits)).not.toContain(PASSWORD);
	});

	it("keeps a completed admin action successful when the audit store fails", async () => {
		const f = await fixture();
		failAuditWrites = true;
		const result = await f.auth.api.banUser({
			body: { userId: f.target.id },
			headers: f.operatorHeaders,
		});
		expect(result.user.banned).toBe(true);
		expect(audits).toEqual([]);
	});
});
