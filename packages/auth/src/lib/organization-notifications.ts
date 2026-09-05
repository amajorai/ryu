import { randomUUID } from "node:crypto";
import { User } from "@ryu/db/models/auth.model";
import {
	Member,
	mapBaRole,
	OrgRoleModel,
	type Permission,
	RoleAssignment,
	resolveEffectivePermissions,
	roleSatisfies,
} from "@ryu/db/models/control-plane.model";
import { PlatformInboxNotification } from "@ryu/db/models/inbox-notification.model";
import { OrganizationFeatureControl } from "@ryu/db/models/organization-feature-control.model";
import {
	isOrganizationNotificationEnabled,
	type OrganizationNotificationKind,
	organizationNotificationRecipientRoles,
} from "@ryu/db/models/organization-notification.model";
import { OrganizationActivityEmail } from "@ryu/email";
import {
	organizationFeatureByKey,
	resolveOrganizationFeature,
} from "./organization-features.ts";
import {
	deliverUserNotificationEmail,
	shouldStoreUserNotificationInApp,
} from "./user-notification-delivery.ts";

const MAX_EMAIL = 320;
const MAX_ID = 300;
const MAX_TEXT = 600;

export interface OrganizationNotificationExtraRecipient {
	actionLabel?: string | null;
	actionUrl?: string | null;
	email?: string | null;
	userId?: string | null;
}

export interface OrganizationNotificationInput {
	actionLabel?: string | null;
	actionLabelForOrganization?:
		| ((organizationId: string) => string | null)
		| undefined;
	actionUrl?: string | null;
	actionUrlForOrganization?:
		| ((organizationId: string) => string | null)
		| undefined;
	body: string;
	dedupeKey: string;
	extraRecipients?: readonly OrganizationNotificationExtraRecipient[];
	kind: OrganizationNotificationKind;
	organizationIds: readonly string[];
	sourceId: string;
	sourceType: string;
	subject: string;
	title: string;
}

export interface OrganizationNotificationRecipient {
	actionLabelOverride?: string | null;
	actionUrlOverride?: string | null;
	email: string;
	organizationIds: string[];
	userId: string;
}

interface MemberLike {
	organizationId?: unknown;
	role?: unknown;
	userId?: unknown;
}

interface UserLike {
	_id?: unknown;
	email?: unknown;
}

interface RoleAssignmentLike {
	organizationId?: unknown;
	roleKey?: unknown;
	teamId?: unknown;
	userId?: unknown;
}

const text = (value: unknown, max: number): string =>
	typeof value === "string" ? value.trim().slice(0, max) : "";

const normalizeEmail = (value: unknown): string =>
	text(value, MAX_EMAIL).toLowerCase();

const uniqueStrings = (values: readonly string[], max: number): string[] => [
	...new Set(values.map((value) => text(value, max)).filter(Boolean)),
];

/** Resolve the member-aware organization notification access switch. */
async function organizationNotificationsEnabled(
	organizationId: string,
	userId: string
): Promise<boolean> {
	const feature = organizationFeatureByKey("products.notify");
	if (!feature) {
		return true;
	}
	try {
		const controls = await OrganizationFeatureControl.find({
			organizationId,
			key: feature.key,
			$or: [{ userId: null }, ...(userId ? [{ userId }] : [])],
		}).limit(2);
		let organizationOverride: boolean | null = null;
		let memberOverride: boolean | null = null;
		for (const control of controls) {
			if (control.userId === null) {
				organizationOverride = control.enabled;
			} else if (control.userId === userId) {
				memberOverride = control.enabled;
			}
		}
		return resolveOrganizationFeature(
			feature,
			organizationOverride,
			memberOverride
		);
	} catch {
		// Notification delivery remains fail-open when the feature-control store is
		// unavailable, matching the existing transactional notification policy.
		return true;
	}
}

function safeActionUrl(value: unknown): string | null {
	const candidate = text(value, MAX_TEXT);
	if (!candidate) {
		return null;
	}
	if (candidate.startsWith("/")) {
		return candidate;
	}
	try {
		const url = new URL(candidate);
		return url.protocol === "http:" || url.protocol === "https:"
			? candidate
			: null;
	} catch {
		return null;
	}
}

/** Build a public Ryu URL for an action included in an organization email. */
export function organizationAppUrl(path: string): string {
	const base = (process.env.FRONTEND_URL || "http://localhost:3001").replace(
		/\/+$/,
		""
	);
	return `${base}/${path.replace(/^\/+/, "")}`;
}

/**
 * Resolve the owner/admin roster for every organization named by an event.
 * Membership and role are read from Better Auth's member collection; the
 * caller never supplies recipients, so a forged client payload cannot redirect
 * organization mail to an arbitrary address.
 */
export async function resolveOrganizationRecipients(
	organizationIds: readonly string[],
	options: {
		kind?: OrganizationNotificationKind;
		roleKeys?: readonly string[];
	} = {}
): Promise<OrganizationNotificationRecipient[]> {
	const ids = uniqueStrings(organizationIds, MAX_ID);
	if (ids.length === 0) {
		return [];
	}

	const members = (await Member.find({
		organizationId: { $in: ids },
	}).select("organizationId role userId")) as unknown as MemberLike[];
	const kind = options.kind;
	const rolesByOrganization = new Map<string, string[]>();
	if (options.roleKeys) {
		const roleKeys = uniqueStrings(options.roleKeys, 80);
		for (const organizationId of ids) {
			rolesByOrganization.set(organizationId, roleKeys);
		}
	} else if (kind) {
		const configured = await Promise.all(
			ids.map(async (organizationId) => {
				try {
					return [
						organizationId,
						(await organizationNotificationRecipientRoles(
							organizationId,
							kind
						)) as string[],
					] as const;
				} catch {
					return [organizationId, ["owner", "admin"]] as const;
				}
			})
		);
		for (const [organizationId, roleKeys] of configured) {
			rolesByOrganization.set(organizationId, [...roleKeys]);
		}
	}

	const hasCustomTarget = [...rolesByOrganization.values()].some((roles) =>
		roles.some((role) => !["owner", "admin", "member", "viewer"].includes(role))
	);
	const customAssignments = hasCustomTarget
		? ((await RoleAssignment.find({
				organizationId: { $in: ids },
				teamId: null,
			}).select(
				"organizationId userId roleKey teamId"
			)) as unknown as RoleAssignmentLike[])
		: [];
	const customRoles = hasCustomTarget
		? await OrgRoleModel.find({
				organizationId: { $in: ids },
				key: {
					$in: [...rolesByOrganization.values()].flat(),
				},
				deletedAt: null,
			})
		: [];
	const validCustomRoles = new Set(
		customRoles.map(
			(role) => `${text(role.organizationId, MAX_ID)}:${text(role.key, 80)}`
		)
	);
	const assignmentsByMember = new Map<string, Set<string>>();
	for (const assignment of customAssignments) {
		const organizationId = text(assignment.organizationId, MAX_ID);
		const userId = text(assignment.userId, MAX_ID);
		const roleKey = text(assignment.roleKey, 80).toLowerCase();
		if (
			organizationId &&
			userId &&
			roleKey &&
			validCustomRoles.has(`${organizationId}:${roleKey}`)
		) {
			const key = `${organizationId}:${userId}`;
			const roles = assignmentsByMember.get(key) ?? new Set<string>();
			roles.add(roleKey);
			assignmentsByMember.set(key, roles);
		}
	}

	const matchesRole = (rawRole: unknown, target: string): boolean => {
		const role = mapBaRole(text(rawRole, 80));
		if (target === "owner") {
			return role === "owner";
		}
		if (target === "admin") {
			return roleSatisfies(role, "admin");
		}
		if (target === "member") {
			return roleSatisfies(role, "member");
		}
		if (target === "viewer") {
			return true;
		}
		return false;
	};
	const organizationIdsByUser = new Map<string, Set<string>>();
	for (const member of members) {
		const userId = text(member.userId, MAX_ID);
		const organizationId = text(member.organizationId, MAX_ID);
		const roleKeys = rolesByOrganization.get(organizationId) ?? [
			"owner",
			"admin",
		];
		const memberCustomRoles = assignmentsByMember.get(
			`${organizationId}:${userId}`
		);
		const receives = roleKeys.some(
			(roleKey) =>
				matchesRole(member.role, roleKey) ||
				Boolean(memberCustomRoles?.has(roleKey.toLowerCase()))
		);
		if (!(userId && organizationId && receives)) {
			continue;
		}
		const memberOrganizations =
			organizationIdsByUser.get(userId) ?? new Set<string>();
		memberOrganizations.add(organizationId);
		organizationIdsByUser.set(userId, memberOrganizations);
	}
	if (organizationIdsByUser.size === 0) {
		return [];
	}

	const users = (await User.find({
		_id: { $in: [...organizationIdsByUser.keys()] },
	}).select("email")) as unknown as UserLike[];
	const emailByUserId = new Map<string, string>();
	for (const user of users) {
		const userId = text(user._id, MAX_ID);
		const email = normalizeEmail(user.email);
		if (userId && email) {
			emailByUserId.set(userId, email);
		}
	}

	return [...organizationIdsByUser.entries()].flatMap(
		([userId, memberOrganizations]) => {
			const email = emailByUserId.get(userId);
			return email
				? [
						{
							email,
							organizationIds: [...memberOrganizations],
							userId,
						},
					]
				: [];
		}
	);
}

/**
 * Resolve organization members who hold a canonical Ryu permission. This is
 * used for resources such as org-owned Agent Mail inboxes where membership
 * alone is not a sufficient read boundary. Team-scoped role assignments do not
 * grant access to an organization-wide resource.
 */
export async function resolveOrganizationPermissionRecipients(
	organizationId: string,
	permission: Permission
): Promise<OrganizationNotificationRecipient[]> {
	const members = (await Member.find({ organizationId }).select(
		"organizationId role userId"
	)) as unknown as MemberLike[];
	if (members.length === 0) {
		return [];
	}
	const userIds = uniqueStrings(
		members.map((member) => text(member.userId, MAX_ID)),
		MAX_ID
	);
	const assignments = (await RoleAssignment.find({
		organizationId,
		userId: { $in: userIds },
		teamId: null,
	}).select("userId roleKey teamId")) as unknown as RoleAssignmentLike[];
	const roleKeys = uniqueStrings(
		assignments.map((assignment) => text(assignment.roleKey, 80)),
		80
	);
	const roles =
		roleKeys.length > 0
			? await OrgRoleModel.find({
					organizationId,
					key: { $in: roleKeys },
					deletedAt: null,
				})
			: [];
	const permissionsByRole = new Map(
		roles.map((role) => [role.key, role.permissions as string[]])
	);
	const assignmentKeysByUser = new Map<string, Set<string>>();
	for (const assignment of assignments) {
		const userId = text(assignment.userId, MAX_ID);
		const roleKey = text(assignment.roleKey, 80);
		if (!(userId && permissionsByRole.has(roleKey))) {
			continue;
		}
		const keys = assignmentKeysByUser.get(userId) ?? new Set<string>();
		keys.add(roleKey);
		assignmentKeysByUser.set(userId, keys);
	}
	const eligibleIds = members.flatMap((member) => {
		const userId = text(member.userId, MAX_ID);
		const assigned = [...(assignmentKeysByUser.get(userId) ?? new Set())].map(
			(roleKey) => ({
				permissions: permissionsByRole.get(roleKey) ?? [],
				teamId: null,
			})
		);
		const permissions = resolveEffectivePermissions({
			assignedRoleDocs: assigned,
			baRole: text(member.role, 80),
		});
		return permissions.includes(permission) ? [userId] : [];
	});
	if (eligibleIds.length === 0) {
		return [];
	}
	const users = (await User.find({
		_id: { $in: eligibleIds },
	}).select("email")) as unknown as UserLike[];
	const emailByUserId = new Map(
		users.flatMap((user) => {
			const userId = text(user._id, MAX_ID);
			const email = normalizeEmail(user.email);
			return userId && email ? [[userId, email] as const] : [];
		})
	);
	return [...new Set(eligibleIds)].flatMap((userId) => {
		const email = emailByUserId.get(userId);
		return email ? [{ email, organizationIds: [organizationId], userId }] : [];
	});
}

async function resolveExtraRecipient(
	recipient: OrganizationNotificationExtraRecipient,
	organizationIds: readonly string[]
): Promise<OrganizationNotificationRecipient | null> {
	let userId = text(recipient.userId, MAX_ID);
	let email = normalizeEmail(recipient.email);
	if (userId && !email) {
		const user = (await User.findById(userId).select(
			"email"
		)) as UserLike | null;
		email = normalizeEmail(user?.email);
	} else if (!userId && email) {
		// Resolve a registered invitee by address so their personal channel
		// preference still applies. Unregistered invitees remain email-only and
		// continue through the required Better Auth invitation path.
		const user = (await User.findOne({ email }).select(
			"_id"
		)) as UserLike | null;
		userId = text(user?._id, MAX_ID);
	}
	if (!email) {
		return null;
	}
	return {
		actionLabelOverride:
			recipient.actionLabel === undefined
				? undefined
				: text(recipient.actionLabel, 80) || null,
		actionUrlOverride:
			recipient.actionUrl === undefined
				? undefined
				: safeActionUrl(recipient.actionUrl),
		email,
		organizationIds: uniqueStrings(organizationIds, MAX_ID),
		userId,
	};
}

function mergeRecipients(
	base: OrganizationNotificationRecipient[],
	extra: OrganizationNotificationRecipient
): void {
	const existing = base.find(
		(recipient) =>
			(Boolean(extra.userId) && recipient.userId === extra.userId) ||
			recipient.email === extra.email
	);
	if (!existing) {
		base.push(extra);
		return;
	}
	for (const organizationId of extra.organizationIds) {
		if (!existing.organizationIds.includes(organizationId)) {
			existing.organizationIds.push(organizationId);
		}
	}
	if (!existing.userId && extra.userId) {
		existing.userId = extra.userId;
	}
	if (existing.actionUrlOverride === undefined) {
		existing.actionUrlOverride = extra.actionUrlOverride;
	}
	if (existing.actionLabelOverride === undefined) {
		existing.actionLabelOverride = extra.actionLabelOverride;
	}
}

function actionLabelFor(
	input: OrganizationNotificationInput,
	recipient: OrganizationNotificationRecipient
): string | null {
	if (recipient.actionLabelOverride !== undefined) {
		return recipient.actionLabelOverride;
	}
	if (input.actionLabelForOrganization) {
		for (const organizationId of recipient.organizationIds) {
			const label = input.actionLabelForOrganization(organizationId);
			if (label) {
				return text(label, 80);
			}
		}
	}
	return text(input.actionLabel, 80) || null;
}

function actionUrlFor(
	input: OrganizationNotificationInput,
	recipient: OrganizationNotificationRecipient
): string | null {
	if (recipient.actionUrlOverride !== undefined) {
		return recipient.actionUrlOverride;
	}
	if (input.actionUrlForOrganization) {
		for (const organizationId of recipient.organizationIds) {
			const url = input.actionUrlForOrganization(organizationId);
			if (url) {
				const safeUrl = safeActionUrl(url);
				if (safeUrl) {
					return safeUrl;
				}
			}
		}
	}
	return safeActionUrl(input.actionUrl);
}

async function sendOrganizationEmail(
	input: OrganizationNotificationInput,
	recipient: OrganizationNotificationRecipient,
	enabledOrganizationIds: ReadonlySet<string>
): Promise<void> {
	const organizationId = recipient.organizationIds.find((id) =>
		enabledOrganizationIds.has(id)
	);
	if (!organizationId) {
		return;
	}

	await deliverUserNotificationEmail({
		actionLabel: actionLabelFor(input, recipient),
		actionUrl: actionUrlFor(input, recipient),
		body: text(input.body, MAX_TEXT),
		dedupeKey: `organization:${text(input.dedupeKey, MAX_ID)}`,
		email: recipient.email,
		kind: input.kind,
		organizationId,
		organizationKind: input.kind,
		react: OrganizationActivityEmail({
			actionLabel: actionLabelFor(input, recipient),
			actionUrl: actionUrlFor(input, recipient),
			body: text(input.body, MAX_TEXT),
			heading: text(input.title, 140),
			preview: text(input.subject, 180),
		}),
		subject: text(input.subject, 180),
		userId: recipient.userId || null,
	});
}

async function publishOrganizationInboxNotification(
	input: OrganizationNotificationInput,
	recipient: OrganizationNotificationRecipient
): Promise<void> {
	if (!recipient.userId) {
		return;
	}
	if (
		!(await shouldStoreUserNotificationInApp(
			recipient.userId,
			input.kind,
			"transactional"
		))
	) {
		return;
	}
	const dedupeKey = `organization:${text(input.dedupeKey, MAX_ID)}`;
	const createdAt = new Date();
	const actionUrl = actionUrlFor(input, recipient);
	await PlatformInboxNotification.updateOne(
		{ userId: recipient.userId, dedupeKey },
		{
			$set: {
				active: true,
				category: "transactional",
				kind: text(input.kind, 120),
				sourceType: text(input.sourceType, 120),
				sourceId: text(input.sourceId, MAX_ID),
				title: text(input.title, 140),
				body: text(input.body, MAX_TEXT),
				icon: "building-2",
				color: null,
				actionLabel: actionLabelFor(input, recipient),
				actionUrl,
				updatedAt: createdAt,
			},
			$setOnInsert: {
				_id: randomUUID(),
				userId: recipient.userId,
				dedupeKey,
				createdAt,
			},
		},
		{ upsert: true }
	);
}

/**
 * Fan one organization lifecycle event to every owner/admin on both sides.
 * Inbox persistence is independent from the email preference: turning email
 * off does not erase the server-side history. All delivery errors are logged
 * and contained so a mail provider outage cannot roll back the business event.
 */
export async function notifyOrganizationEvent(
	input: OrganizationNotificationInput
): Promise<void> {
	try {
		const organizationIds = uniqueStrings(input.organizationIds, MAX_ID);
		if (
			organizationIds.length === 0 ||
			!text(input.dedupeKey, MAX_ID) ||
			!text(input.sourceId, MAX_ID) ||
			!text(input.sourceType, 120) ||
			!text(input.title, 140)
		) {
			return;
		}

		const recipients = await resolveOrganizationRecipients(organizationIds, {
			kind: input.kind,
		});
		for (const extra of input.extraRecipients ?? []) {
			const resolved = await resolveExtraRecipient(extra, organizationIds);
			if (resolved) {
				mergeRecipients(recipients, resolved);
			}
		}
		const enabledRecipients: OrganizationNotificationRecipient[] = [];
		for (const recipient of recipients) {
			const enabledOrganizationIds: string[] = [];
			for (const organizationId of recipient.organizationIds) {
				if (
					await organizationNotificationsEnabled(
						organizationId,
						recipient.userId
					)
				) {
					enabledOrganizationIds.push(organizationId);
				}
			}
			if (enabledOrganizationIds.length > 0) {
				enabledRecipients.push({
					...recipient,
					organizationIds: enabledOrganizationIds,
				});
			}
		}
		if (enabledRecipients.length === 0) {
			return;
		}

		const enabledOrganizationIds = new Set(
			(
				await Promise.all(
					organizationIds.map(async (organizationId) =>
						(await isOrganizationNotificationEnabled(
							organizationId,
							input.kind
						))
							? organizationId
							: null
					)
				)
			).filter((organizationId): organizationId is string =>
				Boolean(organizationId)
			)
		);

		await Promise.all(
			enabledRecipients.map(async (recipient) => {
				try {
					await publishOrganizationInboxNotification(input, recipient);
				} catch (error) {
					console.error(
						"[organization-notification] inbox write failed:",
						error instanceof Error ? error.message : error
					);
				}
				try {
					await sendOrganizationEmail(input, recipient, enabledOrganizationIds);
				} catch (error) {
					console.error(
						"[organization-notification] delivery claim failed:",
						error instanceof Error ? error.message : error
					);
				}
			})
		);
	} catch (error) {
		console.error(
			"[organization-notification] event delivery failed:",
			error instanceof Error ? error.message : error
		);
	}
}
