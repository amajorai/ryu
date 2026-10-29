import { describe, expect, it } from "bun:test";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { organization } from "better-auth/plugins";
import type { AuthFixtureDatabase } from "./auth-test-fixtures.ts";
import { organizationMutationSucceeded } from "./organization-mutation-result.ts";

describe("organization mutation audit outcomes", () => {
	it("rejects native and serialized errors and failed HTTP responses", () => {
		for (const result of [
			new APIError("FORBIDDEN"),
			{ name: "APIError", statusCode: 400 },
			new Response(null, { status: 403 }),
		]) {
			expect(organizationMutationSucceeded(result)).toBe(false);
		}
		for (const result of [
			null,
			{ success: true },
			new Response(null, { status: 204 }),
		]) {
			expect(organizationMutationSucceeded(result)).toBe(true);
		}
	});

	it("real Better Auth rejects cross-tenant deletion without recording success", async () => {
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
		const audits: string[] = [];
		const outcomes: boolean[] = [];
		const auth = betterAuth({
			baseURL: "http://localhost:3000",
			secret: "organization-audit-test-secret-at-least-32-characters",
			database: memoryAdapter(database),
			emailAndPassword: { enabled: true },
			plugins: [organization()],
			hooks: {
				after: createAuthMiddleware(async (ctx) => {
					if (ctx.path !== "/organization/delete") {
						return;
					}
					const succeeded = organizationMutationSucceeded(ctx.context.returned);
					outcomes.push(succeeded);
					if (succeeded) {
						audits.push(String(ctx.body.organizationId));
					}
				}),
			},
		});
		const signup = await auth.api.signUpEmail({
			body: {
				name: "Owner",
				email: "owner@example.com",
				password: "test-password-1234",
			},
			asResponse: true,
		});
		const cookie = signup.headers
			.getSetCookie()
			.map((value) => value.split(";")[0])
			.join("; ");
		const userId = String(database.user[0]?.id);
		for (const id of ["owned-org", "victim-org"]) {
			database.organization.push({
				id,
				name: id,
				slug: id,
				createdAt: new Date(),
			});
		}
		database.member.push({
			id: "own-membership",
			organizationId: "owned-org",
			userId,
			role: "owner",
			createdAt: new Date(),
		});
		async function remove(organizationId: string) {
			return await auth.handler(
				new Request("http://localhost:3000/api/auth/organization/delete", {
					method: "POST",
					headers: {
						cookie,
						origin: "http://localhost:3000",
						"content-type": "application/json",
					},
					body: JSON.stringify({ organizationId }),
				})
			);
		}
		const denied = await remove("victim-org");
		expect(denied.status).toBe(400);
		expect(await denied.json()).toMatchObject({
			code: "USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION",
		});
		expect(outcomes).toEqual([false]);
		expect(audits).toEqual([]);
		expect(database.organization.some((row) => row.id === "victim-org")).toBe(
			true
		);
		const allowed = await remove("owned-org");
		expect(allowed.status).toBe(200);
		expect(outcomes).toEqual([false, true]);
		expect(audits).toEqual(["owned-org"]);
		expect(database.organization.some((row) => row.id === "owned-org")).toBe(
			false
		);
	});
});
