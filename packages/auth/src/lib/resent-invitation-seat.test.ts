import { describe, expect, it } from "bun:test";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { organization } from "better-auth/plugins";
import { z } from "zod";
import type { AuthFixtureDatabase } from "./auth-test-fixtures.ts";
import {
	type ResentInvitationSeat,
	successfulResentInvitationSeat,
} from "./resent-invitation-seat.ts";

describe("resent invitation seat authority", () => {
	it("rejects failed, unauthenticated, expired and non-pending outcomes", () => {
		const valid = {
			id: "invite",
			organizationId: "org",
			status: "pending",
			expiresAt: new Date(Date.now() + 60_000),
		};
		for (const returned of [
			new APIError("UNAUTHORIZED"),
			new Response(null, { status: 403 }),
			{ ...valid, status: "accepted" },
			{ ...valid, expiresAt: "invalid" },
			{ ...valid, expiresAt: new Date(0) },
		]) {
			expect(
				successfulResentInvitationSeat({
					returned,
					resend: true,
				})
			).toBeNull();
		}
		expect(
			successfulResentInvitationSeat({
				returned: valid,
				resend: false,
			})
		).toBeNull();
		expect(
			successfulResentInvitationSeat({
				returned: valid,
				resend: true,
			})
		).toEqual({
			invitationId: "invite",
			organizationId: "org",
			expiresAt: valid.expiresAt,
		});
	});

	it("real Better Auth denies outsider resends and uses the owner's authoritative invitation expiry", async () => {
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
		const writes: ResentInvitationSeat[] = [];
		let sent = 0;
		const auth = betterAuth({
			baseURL: "http://localhost:3000",
			secret: "invitation-seat-test-secret-at-least-32-characters",
			database: memoryAdapter(database),
			emailAndPassword: { enabled: true },
			plugins: [
				organization({
					invitationExpiresIn: 120,
					sendInvitationEmail: async () => {
						sent += 1;
					},
				}),
			],
			hooks: {
				after: createAuthMiddleware(async (ctx) => {
					if (ctx.path !== "/organization/invite-member") {
						return;
					}
					const seat = successfulResentInvitationSeat({
						returned: ctx.context.returned,
						resend: ctx.body.resend,
					});
					if (seat) {
						writes.push(seat);
					}
				}),
			},
		});
		async function signup(email: string) {
			const response = await auth.api.signUpEmail({
				body: { name: "Fixture", email, password: "test-password-1234" },
				asResponse: true,
			});
			const user = z
				.object({ user: z.object({ id: z.string() }) })
				.parse(await response.json());
			return {
				id: user.user.id,
				cookie: response.headers
					.getSetCookie()
					.map((value) => value.split(";")[0])
					.join("; "),
			};
		}
		const owner = await signup("owner@example.com");
		const outsider = await signup("outsider@example.com");
		database.organization.push({
			id: "victim-org",
			name: "Victim",
			slug: "victim",
			createdAt: new Date(),
		});
		database.member.push({
			id: "member",
			userId: owner.id,
			organizationId: "victim-org",
			role: "owner",
			createdAt: new Date(),
		});
		database.invitation.push({
			id: "existing-invitation",
			organizationId: "victim-org",
			inviterId: owner.id,
			email: "recipient@example.com",
			role: "member",
			status: "pending",
			createdAt: new Date(),
			expiresAt: new Date(Date.now() + 600_000),
		});
		async function resend(cookie?: string) {
			return await auth.handler(
				new Request(
					"http://localhost:3000/api/auth/organization/invite-member",
					{
						method: "POST",
						headers: {
							"content-type": "application/json",
							origin: "http://localhost:3000",
							cookie: cookie ?? "",
						},
						body: JSON.stringify({
							organizationId: "victim-org",
							email: "recipient@example.com",
							role: "member",
							resend: true,
						}),
					}
				)
			);
		}
		expect((await resend()).status).toBe(401);
		expect(writes).toHaveLength(0);
		const rejected = await resend(outsider.cookie);
		expect(rejected.status).toBe(400);
		expect(await rejected.json()).toMatchObject({ code: "MEMBER_NOT_FOUND" });
		expect(writes).toHaveLength(0);
		expect(sent).toBe(0);
		const before = Date.now();
		const allowed = await resend(owner.cookie);
		expect(allowed.status).toBe(200);
		const invitation = z
			.object({
				id: z.string(),
				organizationId: z.string(),
				expiresAt: z.string(),
			})
			.parse(await allowed.json());
		expect(writes).toHaveLength(1);
		expect(writes[0]?.invitationId).toBe(invitation.id);
		expect(writes[0]?.organizationId).toBe(invitation.organizationId);
		expect(writes[0]?.expiresAt.toISOString()).toBe(invitation.expiresAt);
		expect(writes[0]?.expiresAt.getTime()).toBeGreaterThanOrEqual(
			before + 120_000
		);
		expect(writes[0]?.expiresAt.getTime()).toBeLessThan(before + 130_000);
		expect(sent).toBe(1);
	});
});
