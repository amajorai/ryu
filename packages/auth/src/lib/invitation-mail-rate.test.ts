import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	setSystemTime,
} from "bun:test";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { organization } from "better-auth/plugins";
import { createElement } from "react";
import { z } from "zod";
import type { AuthFixtureDatabase } from "./auth-test-fixtures.ts";

const recipient = "victim@business.example";
const deliveries: { to: string; subject: string }[] = [];
const claims = new Set<string>();
const quota = new Map<string, { attempts: number; lastReservedAt: Date }>();
let quotaUnavailable = false;
let authenticationStats = 0;
const fixtureStart = Date.UTC(2026, 9, 5, 8);
let clock = fixtureStart;
// Pin the whole system clock, not only Date.now(): Better Auth mints session expiry from
// Date.now() but validates it against new Date(), so a Date.now()-only spy lets the real
// wall clock outrun the synthetic seven-day session once the fixture date is a week old.
function setClock(timestamp: number) {
	clock = timestamp;
	setSystemTime(clock);
}
const previousKey = process.env.USESEND_API_KEY;
const previousUrl = process.env.USESEND_URL;
const originalFetch = globalThis.fetch;
const claimOptions: { upsert: boolean; new: boolean }[] = [];
let sendEmail: typeof import("@ryu/email")["sendEmail"];
let notifyOrganizationEvent: typeof import("./organization-notifications.ts")["notifyOrganizationEvent"];
let checkNotificationEmailRateLimit: typeof import("./notification-email-rate.ts")["checkNotificationEmailRateLimit"];

beforeAll(async () => {
	setClock(fixtureStart);
	process.env.USESEND_API_KEY = "synthetic-test-provider-key";
	process.env.USESEND_URL = "http://127.0.0.1:39001";
	globalThis.fetch = Object.assign(
		async (
			input: Parameters<typeof fetch>[0],
			init?: Parameters<typeof fetch>[1]
		) => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			if (
				url.origin !== "http://127.0.0.1:39001" ||
				!url.pathname.endsWith("/emails")
			) {
				throw new Error("Unexpected network request in isolated email fixture");
			}
			const encodedBody = z.string().parse(init?.body);
			const body = z
				.object({ to: z.string(), subject: z.string() })
				.parse(JSON.parse(encodedBody));
			deliveries.push({ to: body.to, subject: body.subject });
			return Response.json({ id: "synthetic-delivery" });
		},
		{ preconnect: () => undefined }
	);
	mock.module("@ryu/db/models/notification-email-rate.model", () => ({
		NotificationEmailRate: {
			findOneAndUpdate: async (
				filter: {
					_id: string;
					attempts: { $lt: number };
					lastReservedAt: { $lte: Date };
				},
				update: { $inc: { attempts: number }; $set: { lastReservedAt: Date } },
				options: { upsert: boolean; new: boolean }
			) => {
				if (quotaUnavailable) {
					throw new Error("synthetic quota outage");
				}
				claimOptions.push(options);
				const prior = quota.get(filter._id);
				if (
					prior &&
					(prior.attempts >= filter.attempts.$lt ||
						prior.lastReservedAt > filter.lastReservedAt.$lte)
				) {
					throw Object.assign(new Error("duplicate recipient/day key"), {
						code: 11_000,
					});
				}
				const next = {
					attempts: (prior?.attempts ?? 0) + update.$inc.attempts,
					lastReservedAt: update.$set.lastReservedAt,
				};
				quota.set(filter._id, next);
				return next;
			},
		},
	}));
	mock.module("@ryu/db/models/auth.model", () => ({
		User: {
			find: () => ({ select: async () => [] }),
			findOne: () => ({
				select: async () => ({ _id: "registered-victim", email: recipient }),
			}),
			findById: () => ({
				select: async () => ({ _id: "registered-victim", email: recipient }),
			}),
		},
	}));
	const canonical = await import("@ryu/db/models/control-plane.model");
	mock.module("@ryu/db/models/control-plane.model", () => ({
		...canonical,
		Member: { find: () => ({ select: async () => [] }) },
		RoleAssignment: { find: async () => [] },
		OrgRoleModel: { find: async () => [] },
	}));
	mock.module("@ryu/db/models/billing-email.model", () => ({
		BillingEmailDelivery: {
			findOneAndUpdate: async () => null,
			create: async (input: { dedupeKey: string }) => {
				if (claims.has(input.dedupeKey)) {
					throw Object.assign(new Error("duplicate delivery"), {
						code: 11_000,
					});
				}
				claims.add(input.dedupeKey);
				return input;
			},
			updateOne: async () => ({ modifiedCount: 1 }),
		},
	}));
	mock.module("@ryu/db/models/inbox-notification.model", () => ({
		PlatformInboxNotification: {
			updateOne: async () => ({ upsertedCount: 1 }),
		},
	}));
	mock.module("@ryu/db/models/organization-feature-control.model", () => ({
		OrganizationFeatureControl: { find: () => ({ limit: async () => [] }) },
		OrganizationTeamFeatureControl: {
			find: () => ({ limit: () => ({ lean: async () => [] }) }),
		},
	}));
	mock.module("@ryu/db/models/organization-notification.model", () => ({
		isOrganizationNotificationEnabled: async () => true,
		organizationNotificationRecipientRoles: async () => ["owner", "admin"],
	}));
	mock.module("@ryu/db/models/user-notification.model", () => ({
		isUserNotificationChannelEnabled: async () => true,
	}));
	const email = await import("@ryu/email");
	({ sendEmail } = email);
	({ checkNotificationEmailRateLimit } = await import(
		"./notification-email-rate.ts"
	));
	email.configureNotificationRateLimiting(checkNotificationEmailRateLimit);
	email.configureRateLimiting(
		async () => ({ allowed: authenticationStats < 20 }),
		async () => {
			authenticationStats += 1;
		}
	);
	({ notifyOrganizationEvent } = await import(
		"./organization-notifications.ts"
	));
}, 60_000);
beforeEach(() => {
	deliveries.length = 0;
	claims.clear();
	quota.clear();
	claimOptions.length = 0;
	quotaUnavailable = false;
	authenticationStats = 0;
	setClock(fixtureStart);
});
afterAll(() => {
	setSystemTime();
	mock.restore();
	globalThis.fetch = originalFetch;
	if (previousUrl === undefined) {
		delete process.env.USESEND_URL;
	} else {
		process.env.USESEND_URL = previousUrl;
	}
	if (previousKey === undefined) {
		delete process.env.USESEND_API_KEY;
	} else {
		process.env.USESEND_API_KEY = previousKey;
	}
});

describe("recipient notification quota is separate from authentication", () => {
	it("bounds non-user recipients independently and opens a fresh allowance on the next UTC day", async () => {
		for (let index = 0; index < 20; index += 1) {
			expect(
				(await checkNotificationEmailRateLimit("unregistered@business.example"))
					.allowed
			).toBe(true);
			setClock(clock + 61_000);
		}
		expect(
			(await checkNotificationEmailRateLimit("unregistered@business.example"))
				.allowed
		).toBe(false);
		expect(
			(await checkNotificationEmailRateLimit("different@business.example"))
				.allowed
		).toBe(true);
		setClock(Date.UTC(2026, 9, 6, 8));
		expect(
			(await checkNotificationEmailRateLimit("unregistered@business.example"))
				.allowed
		).toBe(true);
	});
	it("atomically admits one concurrent recipient claim across casing and fails closed on outage", async () => {
		const results = await Promise.all(
			Array.from({ length: 30 }, (_, index) =>
				checkNotificationEmailRateLimit(
					index % 2 ? recipient.toUpperCase() : recipient
				)
			)
		);
		expect(results.filter((result) => result.allowed)).toHaveLength(1);
		expect(quota.size).toBe(1);
		expect(claimOptions.every((options) => options.upsert && options.new)).toBe(
			true
		);
		quotaUnavailable = true;
		expect(
			(await checkNotificationEmailRateLimit("another@business.example"))
				.allowed
		).toBe(false);
	});

	it("does not let skipRateLimit bypass notification admission or consume authentication stats", async () => {
		await sendEmail({
			deliveryClass: "notification",
			skipRateLimit: true,
			to: recipient,
			subject: "First notification",
			react: createElement("p", null, "Synthetic notice"),
		});
		await expect(
			sendEmail({
				deliveryClass: "notification",
				skipRateLimit: true,
				to: recipient,
				subject: "Bypass attempt",
				react: createElement("p", null, "Synthetic notice"),
			})
		).rejects.toThrow("Notification email limit exceeded");
		expect(deliveries).toHaveLength(1);
		expect(authenticationStats).toBe(0);
	});

	it("real native cancellation across 21 organizations is bounded while password reset remains available", async () => {
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
			secret: "invitation-mail-synthetic-secret-at-least-32-characters",
			database: memoryAdapter(database),
			emailAndPassword: {
				enabled: true,
				sendResetPassword: async ({ user }) => {
					await sendEmail({
						to: user.email,
						subject: "Password reset",
						react: createElement("p", null, "Synthetic recovery"),
					});
				},
			},
			plugins: [
				organization({
					organizationHooks: {
						afterCancelInvitation: async ({ invitation }) => {
							await notifyOrganizationEvent({
								kind: "organization-invitation",
								organizationIds: [invitation.organizationId],
								extraRecipients: [{ email: invitation.email }],
								sourceId: invitation.id,
								sourceType: "organization-invitation",
								dedupeKey: `organization-invitation:${invitation.id}:cancelled`,
								subject: "Organization invitation cancelled",
								title: "Organization invitation cancelled",
								body: "The synthetic invitation was cancelled.",
							});
						},
					},
				}),
			],
		});
		const signup = await auth.api.signUpEmail({
			body: {
				name: "Synthetic owner",
				email: "owner@business.example",
				password: "synthetic-password-1234",
			},
			asResponse: true,
		});
		const cookie = signup.headers
			.getSetCookie()
			.map((value) => value.split(";")[0])
			.join("; ");
		const ownerId = String(database.user[0]?.id);
		const owner = database.user.find((user) => user.id === ownerId);
		if (!owner) {
			throw new Error("Missing synthetic owner");
		}
		owner.emailVerified = true;
		await auth.api.signUpEmail({
			body: {
				name: "Synthetic victim",
				email: recipient,
				password: "synthetic-password-5678",
			},
		});
		for (let index = 0; index < 21; index += 1) {
			const org = `organization-${index}`;
			database.organization.push({
				id: org,
				name: org,
				slug: org,
				createdAt: new Date(),
			});
			database.member.push({
				id: `member-${index}`,
				userId: ownerId,
				organizationId: org,
				role: "owner",
				createdAt: new Date(),
			});
			database.invitation.push({
				id: `invite-${index}`,
				organizationId: org,
				inviterId: ownerId,
				email: recipient,
				role: "member",
				status: "pending",
				createdAt: new Date(),
				expiresAt: new Date(Date.now() + 86_400_000),
			});
		}
		async function cancel(invitationId: string, sessionCookie?: string) {
			return await auth.handler(
				new Request(
					"http://localhost:3000/api/auth/organization/cancel-invitation",
					{
						method: "POST",
						headers: {
							"content-type": "application/json",
							origin: "http://localhost:3000",
							cookie: sessionCookie ?? "",
						},
						body: JSON.stringify({ invitationId }),
					}
				)
			);
		}
		expect((await cancel("invite-0")).status).toBe(401);
		expect(deliveries).toHaveLength(0);
		for (let index = 0; index < 21; index += 1) {
			expect((await cancel(`invite-${index}`, cookie)).status).toBe(200);
			setClock(clock + 61_000);
		}
		expect(
			deliveries.filter((delivery) => delivery.to === recipient)
		).toHaveLength(20);
		expect(authenticationStats).toBe(0);
		expect(
			database.invitation.every((invite) => invite.status === "canceled")
		).toBe(true);
		const reset = await auth.handler(
			new Request("http://localhost:3000/api/auth/request-password-reset", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					origin: "http://localhost:3000",
				},
				body: JSON.stringify({ email: recipient }),
			})
		);
		expect(reset.status).toBe(200);
		expect(
			deliveries.filter((delivery) => delivery.subject === "Password reset")
		).toHaveLength(1);
		expect(authenticationStats).toBe(1);
	});
});
