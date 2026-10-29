import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";

// A re-invited member's custom-role grant from an earlier membership must not
// make them a notification or permission recipient (stale-grant cleanup is
// best effort, so readers filter by the current member row's createdAt).

const ORG = "org-1";
const JOINED = new Date("2026-10-01T00:00:00Z");
const BEFORE = new Date("2026-09-01T00:00:00Z");
const AFTER = new Date("2026-10-02T00:00:00Z");

const users = [
	{ _id: "current-1", email: "current@example.com" },
	{ _id: "reinvited-1", email: "reinvited@example.com" },
	{ _id: "legacy-1", email: "legacy@example.com" },
];
const members = [
	{
		createdAt: JOINED,
		organizationId: ORG,
		role: "member",
		userId: "current-1",
	},
	{
		createdAt: JOINED,
		organizationId: ORG,
		role: "member",
		userId: "reinvited-1",
	},
	// Legacy member row without a createdAt stamp keeps its grants.
	{ organizationId: ORG, role: "member", userId: "legacy-1" },
];
const assignments = [
	{
		createdAt: AFTER,
		organizationId: ORG,
		roleKey: "support",
		userId: "current-1",
	},
	// Granted before the current membership began: a leftover.
	{
		createdAt: BEFORE,
		organizationId: ORG,
		roleKey: "support",
		userId: "reinvited-1",
	},
	{
		createdAt: BEFORE,
		organizationId: ORG,
		roleKey: "support",
		userId: "legacy-1",
	},
];

beforeAll(() => {
	mock.module("@ryu/db/models/auth.model", () => ({
		User: {
			find: (filter: { _id: { $in: string[] } }) => ({
				select: async () =>
					users.filter((user) => filter._id.$in.includes(user._id)),
			}),
		},
	}));
	mock.module("@ryu/db/models/control-plane.model", () => ({
		mapBaRole: (role: string) => role,
		Member: { find: () => ({ select: async () => members }) },
		OrgRoleModel: {
			find: async () => [
				{ key: "support", organizationId: ORG, permissions: ["mail.read"] },
			],
		},
		RoleAssignment: { find: () => ({ select: async () => assignments }) },
		resolveEffectivePermissions: (input: {
			assignedRoleDocs: { permissions: string[] }[];
		}) => input.assignedRoleDocs.flatMap((doc) => doc.permissions),
		roleSatisfies: (role: string, required: string) => role === required,
	}));
	mock.module("@ryu/db/models/inbox-notification.model", () => ({
		PlatformInboxNotification: {},
	}));
	mock.module("@ryu/db/models/organization-notification.model", () => ({
		isOrganizationNotificationEnabled: () => Promise.resolve(true),
		organizationNotificationRecipientRoles: () => Promise.resolve(["support"]),
	}));
	mock.module("./organization-feature-values.ts", () => ({
		resolveOrganizationFeatureValues: async () => new Map(),
	}));
	mock.module("./user-notification-delivery.ts", () => ({
		deliverUserNotificationEmail: async () => true,
		shouldStoreUserNotificationInApp: () => Promise.resolve(true),
	}));
	mock.module("@ryu/email", () => ({
		OrganizationActivityEmail: () => null,
	}));
});

afterAll(() => {
	mock.restore();
});

describe("organization recipients ignore grants from an earlier membership", () => {
	it("does not target a re-invited member through a leftover custom role", async () => {
		const { resolveOrganizationRecipients } = await import(
			"./organization-notifications.ts"
		);
		const recipients = await resolveOrganizationRecipients([ORG], {
			roleKeys: ["support"],
		});
		expect(recipients.map((recipient) => recipient.userId).sort()).toEqual([
			"current-1",
			"legacy-1",
		]);
	});

	it("does not count a leftover grant toward a permission such as mail.read", async () => {
		const { resolveOrganizationPermissionRecipients } = await import(
			"./organization-notifications.ts"
		);
		const recipients = await resolveOrganizationPermissionRecipients(
			ORG,
			"mail.read"
		);
		expect(recipients.map((recipient) => recipient.userId).sort()).toEqual([
			"current-1",
			"legacy-1",
		]);
	});
});
