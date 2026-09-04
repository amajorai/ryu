import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";

const sent: { subject: string; to: string }[] = [];
const inbox: { dedupeKey: string; userId: string }[] = [];
const claimed = new Set<string>();
const delivered = new Set<string>();
let enabled = true;

beforeAll(() => {
	mock.module("@ryu/db/models/auth.model", () => ({
		User: {
			find: () => ({
				select: async () => [
					{ _id: "owner-1", email: "owner@example.com" },
					{ _id: "admin-1", email: "admin@example.com" },
					{ _id: "member-1", email: "member@example.com" },
					{ _id: "owner-2", email: "second-owner@example.com" },
				],
			}),
			findById: () => ({ select: async () => null }),
		},
	}));
	mock.module("@ryu/db/models/control-plane.model", () => ({
		mapBaRole: (role: string) =>
			role === "owner" || role === "admin" ? role : "member",
		Member: {
			find: () => ({
				select: async () => [
					{ organizationId: "org-source", role: "owner", userId: "owner-1" },
					{ organizationId: "org-source", role: "admin", userId: "admin-1" },
					{ organizationId: "org-source", role: "member", userId: "member-1" },
					{ organizationId: "org-target", role: "owner", userId: "owner-2" },
				],
			}),
		},
		roleSatisfies: (role: string, required: string) =>
			(required === "admin" && (role === "owner" || role === "admin")) ||
			role === required,
		OrgRoleModel: { find: () => Promise.resolve([]) },
		RoleAssignment: { find: () => Promise.resolve([]) },
		resolveEffectivePermissions: () => [],
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
	mock.module("@ryu/db/models/inbox-notification.model", () => ({
		PlatformInboxNotification: {
			updateOne: async (filter: { dedupeKey: string; userId: string }) => {
				inbox.push(filter);
				return { upsertedCount: 1 };
			},
		},
	}));
	mock.module("@ryu/db/models/organization-notification.model", () => ({
		isOrganizationNotificationEnabled: () => Promise.resolve(enabled),
		organizationNotificationRecipientRoles: () =>
			Promise.resolve(["owner", "admin"]),
	}));
	mock.module("./user-notification-delivery.ts", () => ({
		deliverUserNotificationEmail: async (input: {
			dedupeKey: string;
			email?: string;
			organizationKind?: string;
		}) => {
			if (
				input.organizationKind &&
				enabled &&
				!delivered.has(`${input.dedupeKey}:${input.email ?? ""}`)
			) {
				delivered.add(`${input.dedupeKey}:${input.email ?? ""}`);
				sent.push({
					subject: "organization event",
					to: input.email ?? "",
				});
			}
			return enabled;
		},
		shouldStoreUserNotificationInApp: () => Promise.resolve(true),
	}));
	mock.module("@ryu/email", () => ({
		OrganizationActivityEmail: (props: Record<string, unknown>) => props,
		sendEmail: async (input: { subject: string; to: string }) => {
			sent.push(input);
			return { data: null, success: true };
		},
	}));
});

afterAll(() => {
	mock.restore();
});

describe("organization lifecycle notification delivery", () => {
	it("fans out to owner/admin recipients on both organizations and dedupes email", async () => {
		const { notifyOrganizationEvent } = await import(
			"./organization-notifications.ts"
		);

		const input = {
			actionLabel: "Review activity",
			actionUrl: "https://app.ryuhq.com/inbox",
			body: "A transfer completed.",
			dedupeKey: "server-transfer:transfer-1:completed",
			kind: "organization-activity" as const,
			organizationIds: ["org-source", "org-target"],
			sourceId: "transfer-1",
			sourceType: "server-transfer",
			subject: "Managed node transfer completed",
			title: "Managed node transfer completed",
		};

		await notifyOrganizationEvent(input);
		await notifyOrganizationEvent(input);

		expect(sent.map((email) => email.to)).toEqual([
			"owner@example.com",
			"admin@example.com",
			"second-owner@example.com",
		]);
		expect(inbox.map((row) => row.userId)).toEqual([
			"owner-1",
			"admin-1",
			"owner-2",
			"owner-1",
			"admin-1",
			"owner-2",
		]);
	});

	it("keeps the server inbox row when the organization pauses email", async () => {
		const { notifyOrganizationEvent } = await import(
			"./organization-notifications.ts"
		);
		const beforeSent = sent.length;
		const beforeInbox = inbox.length;
		enabled = false;

		await notifyOrganizationEvent({
			body: "A credit transfer completed.",
			dedupeKey: "credit-transfer:transfer-2",
			kind: "organization-activity",
			organizationIds: ["org-source", "org-target"],
			sourceId: "transfer-2",
			sourceType: "credit-transfer",
			subject: "Organization credit transfer completed",
			title: "Organization credit transfer completed",
		});

		expect(sent).toHaveLength(beforeSent);
		expect(inbox.length).toBe(beforeInbox + 3);
		enabled = true;
	});
});
