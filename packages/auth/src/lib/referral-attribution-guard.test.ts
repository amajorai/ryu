import { describe, expect, it } from "bun:test";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { createAuthMiddleware } from "better-auth/api";
import { bearer } from "better-auth/plugins";
import { z } from "zod";
import type { AuthFixtureDatabase } from "./auth-test-fixtures.ts";
import {
	REFERRED_BY_IMMUTABLE_MESSAGE,
	rejectReferredByUpdate,
} from "./referral-attribution-guard.ts";

const errorBodySchema = z.object({ message: z.string() });
const sessionSchema = z.object({
	user: z.object({ id: z.string() }),
	token: z.string(),
});

async function fixture({
	guarded,
	referredBy,
}: {
	guarded: boolean;
	referredBy?: string;
}) {
	const database: Pick<
		AuthFixtureDatabase,
		"session" | "account" | "verification"
	> & {
		user: (AuthFixtureDatabase["user"][number] & {
			referredBy?: string | null;
		})[];
	} = { user: [], session: [], account: [], verification: [] };
	const auth = betterAuth({
		baseURL: "http://localhost:3000",
		secret: "referral-attribution-guard-secret-at-least-32-characters",
		database: memoryAdapter(database),
		emailAndPassword: { enabled: true },
		user: {
			additionalFields: {
				referredBy: { type: "string", input: true, required: false },
			},
		},
		hooks: guarded
			? {
					before: createAuthMiddleware(async (ctx) => {
						rejectReferredByUpdate(ctx);
					}),
				}
			: {},
		plugins: [bearer()],
	});
	const signup = await auth.api.signUpEmail({
		body: {
			name: "Referee",
			email: "referee@example.com",
			password: "test-password-1234",
			...(referredBy ? { referredBy } : {}),
		},
		asResponse: true,
	});
	const session = sessionSchema.parse(await signup.json());
	const updateUser = (body: Record<string, unknown>) =>
		auth.handler(
			new Request("http://localhost:3000/api/auth/update-user", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					origin: "http://localhost:3000",
					authorization: `Bearer ${session.token}`,
				},
				body: JSON.stringify(body),
			})
		);
	const storedReferredBy = () =>
		database.user.find((user) => user.id === session.user.id)?.referredBy;
	return { storedReferredBy, updateUser };
}

describe("referral attribution guard", () => {
	it("keeps the sign-up referral code", async () => {
		const f = await fixture({ guarded: true, referredBy: "SIGNUPCODE" });
		expect(f.storedReferredBy()).toBe("SIGNUPCODE");
	});

	it("refuses attaching a referrer after sign-up", async () => {
		const f = await fixture({ guarded: true });
		const response = await f.updateUser({ referredBy: "ALTCODE" });
		expect(response.status).toBe(400);
		expect(errorBodySchema.parse(await response.json()).message).toBe(
			REFERRED_BY_IMMUTABLE_MESSAGE
		);
		expect(f.storedReferredBy() ?? null).toBeNull();
	});

	it("refuses repointing or clearing an existing referrer", async () => {
		const f = await fixture({ guarded: true, referredBy: "SIGNUPCODE" });
		for (const referredBy of ["ALTCODE", null, ""]) {
			expect((await f.updateUser({ referredBy })).status).toBe(400);
		}
		expect(f.storedReferredBy()).toBe("SIGNUPCODE");
	});

	it("is what stops Better Auth from accepting the write", async () => {
		const f = await fixture({ guarded: false });
		expect((await f.updateUser({ referredBy: "ALTCODE" })).status).toBe(200);
		expect(f.storedReferredBy()).toBe("ALTCODE");
	});

	it("allows ordinary profile updates", async () => {
		const f = await fixture({ guarded: true, referredBy: "SIGNUPCODE" });
		expect((await f.updateUser({ name: "Renamed" })).status).toBe(200);
		expect(f.storedReferredBy()).toBe("SIGNUPCODE");
	});
});
