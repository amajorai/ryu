import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
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
		| "invitation"
	> = {
		user: [],
		session: [],
		account: [],
		verification: [],
		organization: [],
		member: [],
		invitation: [],
	};
	const auth = betterAuth({
		baseURL: "http://localhost:3000",
		secret: "invite-member-step-up-test-secret-at-least-32-characters",
		database: memoryAdapter(database),
		emailAndPassword: { enabled: true },
		plugins: [
			bearer(),
			organization({ sendInvitationEmail: async () => undefined }),
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
	const post = (
		path: string,
		payload: Record<string, unknown>,
		transport: "cookie" | "bearer"
	) =>
		auth.handler(
			new Request(`http://localhost:3000/api/auth${path}`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					origin: "http://localhost:3000",
					...(transport === "bearer"
						? { authorization: `Bearer ${body.token}` }
						: { cookie }),
				},
				body: JSON.stringify(payload),
			})
		);
	return {
		database,
		grant: () =>
			grants.push({
				sessionId,
				scope: "org.members",
				expiresAt: new Date(Date.now() + 60_000),
			}),
		invite: (
			email: string,
			role: string | string[],
			transport: "cookie" | "bearer" = "bearer"
		) =>
			post(
				"/organization/invite-member",
				{ email, role, organizationId: "org-1" },
				transport
			),
		cancel: (invitationId: string, transport: "cookie" | "bearer" = "bearer") =>
			post("/organization/cancel-invitation", { invitationId }, transport),
	};
}

describe("native invite-member step-up", () => {
	for (const transport of ["cookie", "bearer"] as const) {
		for (const role of ["owner", "admin", ["member", "admin"]]) {
			it(`refuses a ${transport} ${String(role)} invitation without proof and permits it with proof`, async () => {
				const f = await fixture();
				const rejected = await f.invite("new@example.com", role, transport);
				expect(rejected.status).toBe(403);
				expect(await rejected.json()).toMatchObject({
					code: "STEP_UP_REQUIRED",
					scope: "org.members",
				});
				expect(f.database.invitation).toHaveLength(0);
				f.grant();
				const accepted = await f.invite("new@example.com", role, transport);
				expect(accepted.status).toBe(200);
				expect(f.database.invitation).toHaveLength(1);
			});
		}
	}

	it("refuses a billing-manager invitation without proof", async () => {
		// This fixture uses Better Auth's default roles, so the native endpoint
		// would reject `billing` after the gate; Ryu's production config defines
		// it. Only the gate's decision is under test here.
		const f = await fixture();
		const rejected = await f.invite("new@example.com", "billing");
		expect(rejected.status).toBe(403);
		expect(await rejected.json()).toMatchObject({
			code: "STEP_UP_REQUIRED",
			scope: "org.members",
		});
		f.grant();
		const retried = await f.invite("new@example.com", "billing");
		expect(await retried.text()).not.toContain("STEP_UP_REQUIRED");
	});

	for (const role of ["member", "viewer"]) {
		it(`leaves a plain ${role} invitation ungated`, async () => {
			const f = await fixture();
			const response = await f.invite("new@example.com", role);
			// The gate does not fire; whatever the native endpoint answers, it is
			// never a step-up refusal.
			const text = await response.text();
			expect(text).not.toContain("STEP_UP_REQUIRED");
		});
	}

	it("lets a plain member invitation through to the native endpoint", async () => {
		const f = await fixture();
		const response = await f.invite("new@example.com", "member");
		expect(response.status).toBe(200);
		expect(f.database.invitation).toHaveLength(1);
	});
});

describe("native cancel-invitation step-up", () => {
	it("refuses cancellation without proof and permits it with proof", async () => {
		const f = await fixture();
		f.database.invitation.push({
			id: "invitation-1",
			organizationId: "org-1",
			email: "pending@example.com",
			role: "member",
			status: "pending",
			inviterId: String(f.database.user[0]?.id),
			expiresAt: new Date(Date.now() + 86_400_000),
			createdAt: new Date(),
		});
		const rejected = await f.cancel("invitation-1");
		expect(rejected.status).toBe(403);
		expect(await rejected.json()).toMatchObject({
			code: "STEP_UP_REQUIRED",
			scope: "org.members",
		});
		expect(f.database.invitation[0]?.status).toBe("pending");
		f.grant();
		const accepted = await f.cancel("invitation-1");
		expect(accepted.status).toBe(200);
		expect(f.database.invitation[0]?.status).toBe("canceled");
	});
});
