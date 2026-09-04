import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";

const sent: { subject: string; to: string }[] = [];
const claimed = new Set<string>();
let emailEnabled = true;
let organizationEnabled = true;

beforeAll(() => {
	mock.module("@ryu/db/models/auth.model", () => ({
		User: {
			findById: () => ({
				select: async () => ({ email: "Person@example.com" }),
			}),
		},
	}));
	mock.module("@ryu/db/models/billing-email.model", () => ({
		BillingEmailDelivery: {
			create: async (input: { dedupeKey: string }) => {
				if (claimed.has(input.dedupeKey)) {
					throw Object.assign(new Error("duplicate"), { code: 11_000 });
				}
				claimed.add(input.dedupeKey);
				return input;
			},
			findOneAndUpdate: async () => null,
			updateOne: async () => ({ modifiedCount: 1 }),
		},
	}));
	mock.module("@ryu/db/models/organization-notification.model", () => ({
		isOrganizationNotificationEnabled: () =>
			Promise.resolve(organizationEnabled),
	}));
	mock.module("@ryu/db/models/user-notification.model", () => ({
		isUserNotificationChannelEnabled: () => Promise.resolve(emailEnabled),
	}));
	mock.module("@ryu/email", () => ({
		PlatformInboxEmail: () => null,
		sendEmail: async (input: { subject: string; to: string }) => {
			sent.push(input);
		},
	}));
});

afterAll(() => {
	mock.restore();
});

describe("user notification email delivery", () => {
	it("honors both policy layers and dedupes a retry", async () => {
		const { deliverUserNotificationEmail } = await import(
			"./user-notification-delivery.ts"
		);

		const input = {
			body: "A new message arrived.",
			dedupeKey: "agent-mail:inbox-1:message-1",
			kind: "agent-mail",
			organizationId: "org-1",
			organizationKind: "agent-mail" as const,
			subject: "New Agent Mail",
			userId: "user-1",
		};

		expect(await deliverUserNotificationEmail(input)).toBe(true);
		expect(await deliverUserNotificationEmail(input)).toBe(false);
		expect(sent).toEqual([
			expect.objectContaining({
				subject: "New Agent Mail",
				to: "person@example.com",
			}),
		]);
	});

	it("does not send when the user opts out", async () => {
		const { deliverUserNotificationEmail } = await import(
			"./user-notification-delivery.ts"
		);
		emailEnabled = false;

		const delivered = await deliverUserNotificationEmail({
			body: "A billing event happened.",
			dedupeKey: "billing:event-2",
			kind: "topup-success",
			subject: "Top-up complete",
			userId: "user-1",
		});

		expect(delivered).toBe(false);
		expect(sent).toHaveLength(1);
		emailEnabled = true;
	});

	it("does not send when the organization pauses the event", async () => {
		const { deliverUserNotificationEmail } = await import(
			"./user-notification-delivery.ts"
		);
		organizationEnabled = false;

		const delivered = await deliverUserNotificationEmail({
			body: "A billing event happened.",
			dedupeKey: "billing:event-3",
			kind: "topup-success",
			organizationId: "org-1",
			organizationKind: "topup-success",
			subject: "Top-up complete",
			userId: "user-1",
		});

		expect(delivered).toBe(false);
		expect(sent).toHaveLength(1);
	});
});
