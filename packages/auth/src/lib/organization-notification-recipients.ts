// Who receives an organization activity notification: the owner/admin (or
// configured role) roster of each organization, members holding a canonical
// permission, and the explicit extra recipients an event names. Split from
// `organization-notifications.ts`, which re-exports the public resolvers.

import { modelId } from "@ryu/db/model-id";
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
import {
	type OrganizationNotificationKind,
	organizationNotificationRecipientRoles,
} from "@ryu/db/models/organization-notification.model";
import { z } from "zod";
import { grantedInCurrentMembership } from "./membership-grant-filter.ts";

const MAX_EMAIL = 320;
export const MAX_ID = 300;
export const MAX_TEXT = 600;

export interface OrganizationNotificationExtraRecipient {
	actionLabel?: string | null;
	actionUrl?: string | null;
	email?: string | null;
	userId?: string | null;
}

export interface OrganizationNotificationRecipient {
	actionLabelOverride?: string | null;
	actionUrlOverride?: string | null;
	email: string;
	organizationIds: string[];
	userId: string;
}

export const text = z
	.function({
		input: [
			z
				.string()
				.nullish()
				.catch("")
				.transform((value) => value ?? ""),
			z.number(),
		],
		output: z.string(),
	})
	.implement((value, max) => value.trim().slice(0, max));
const normalizeEmail = z
	.string()
	.catch("")
	.transform((value) => value.trim().slice(0, MAX_EMAIL).toLowerCase()).parse;
const userSchema = z.object({
	_id: z.unknown().transform((value) => modelId(value, MAX_ID)),
	email: z.string().catch(""),
});
const membershipStamp = z.date().nullable().catch(null);
const memberSchema = z.object({
	createdAt: membershipStamp,
	organizationId: z.unknown().transform((value) => modelId(value, MAX_ID)),
	role: z.string().catch(""),
	userId: z.unknown().transform((value) => modelId(value, MAX_ID)),
});
const roleAssignmentSchema = z.object({
	createdAt: membershipStamp,
	organizationId: z.unknown().transform((value) => modelId(value, MAX_ID)),
	roleKey: z.string().catch(""),
	userId: z.unknown().transform((value) => modelId(value, MAX_ID)),
});
const roleSchema = z.object({
	organizationId: z.unknown().transform((value) => modelId(value, MAX_ID)),
	key: z.string().catch(""),
	permissions: z.array(z.string()).catch(() => []),
});

export const uniqueStrings = (
	values: readonly string[],
	max: number
): string[] => [
	...new Set(values.map((value) => text(value, max)).filter(Boolean)),
];

export function safeActionUrl(value: string | null | undefined): string | null {
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

	const members = z.array(memberSchema).parse(
		await Member.find({
			organizationId: { $in: ids },
		}).select("organizationId role userId createdAt")
	);
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
						await organizationNotificationRecipientRoles(organizationId, kind),
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
		? z.array(roleAssignmentSchema).parse(
				await RoleAssignment.find({
					organizationId: { $in: ids },
					teamId: null,
				}).select("organizationId userId roleKey teamId createdAt")
			)
		: [];
	// A grant left from an earlier membership never makes a re-invited member a
	// custom-role recipient.
	const memberByOrganizationUser = new Map(
		members.map((member) => [
			`${member.organizationId}:${member.userId}`,
			member,
		])
	);
	const customRoles = hasCustomTarget
		? z.array(roleSchema).parse(
				await OrgRoleModel.find({
					organizationId: { $in: ids },
					key: {
						$in: [...rolesByOrganization.values()].flat(),
					},
					deletedAt: null,
				})
			)
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
		const key = `${organizationId}:${userId}`;
		const member = memberByOrganizationUser.get(key);
		if (
			organizationId &&
			userId &&
			roleKey &&
			member &&
			grantedInCurrentMembership(assignment, member) &&
			validCustomRoles.has(`${organizationId}:${roleKey}`)
		) {
			const roles = assignmentsByMember.get(key) ?? new Set<string>();
			roles.add(roleKey);
			assignmentsByMember.set(key, roles);
		}
	}

	const matchesRole = (rawRole: string, target: string): boolean => {
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
		const userId = modelId(member.userId, MAX_ID);
		const organizationId = modelId(member.organizationId, MAX_ID);
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

	const users = z.array(userSchema).parse(
		await User.find({
			_id: { $in: [...organizationIdsByUser.keys()] },
		}).select("email")
	);
	const emailByUserId = new Map<string, string>();
	for (const user of users) {
		const userId = modelId(user._id, MAX_ID);
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
	const members = z
		.array(memberSchema)
		.parse(
			await Member.find({ organizationId }).select(
				"organizationId role userId createdAt"
			)
		);
	if (members.length === 0) {
		return [];
	}
	const userIds = uniqueStrings(
		members.map((member) => modelId(member.userId, MAX_ID)),
		MAX_ID
	);
	const assignments = z.array(roleAssignmentSchema).parse(
		await RoleAssignment.find({
			organizationId,
			userId: { $in: userIds },
			teamId: null,
		}).select("userId roleKey teamId createdAt")
	);
	// Grants left from an earlier membership never confer the permission.
	const memberByUser = new Map(
		members.map((member) => [modelId(member.userId, MAX_ID), member])
	);
	const roleKeys = uniqueStrings(
		assignments.map((assignment) => text(assignment.roleKey, 80)),
		80
	);
	const roles =
		roleKeys.length > 0
			? z.array(roleSchema).parse(
					await OrgRoleModel.find({
						organizationId,
						key: { $in: roleKeys },
						deletedAt: null,
					})
				)
			: [];
	const permissionsByRole = new Map(
		roles.map((role) => [role.key, role.permissions])
	);
	const assignmentKeysByUser = new Map<string, Set<string>>();
	for (const assignment of assignments) {
		const userId = text(assignment.userId, MAX_ID);
		const roleKey = text(assignment.roleKey, 80);
		const member = memberByUser.get(userId);
		if (
			!(
				userId &&
				member &&
				grantedInCurrentMembership(assignment, member) &&
				permissionsByRole.has(roleKey)
			)
		) {
			continue;
		}
		const keys = assignmentKeysByUser.get(userId) ?? new Set<string>();
		keys.add(roleKey);
		assignmentKeysByUser.set(userId, keys);
	}
	const eligibleIds = members.flatMap((member) => {
		const userId = modelId(member.userId, MAX_ID);
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
	const users = z.array(userSchema).parse(
		await User.find({
			_id: { $in: eligibleIds },
		}).select("email")
	);
	const emailByUserId = new Map(
		users.flatMap((user) => {
			const userId = modelId(user._id, MAX_ID);
			const email = normalizeEmail(user.email);
			return userId && email ? [[userId, email] as const] : [];
		})
	);
	return [...new Set(eligibleIds)].flatMap((userId) => {
		const email = emailByUserId.get(userId);
		return email ? [{ email, organizationIds: [organizationId], userId }] : [];
	});
}

export async function resolveExtraRecipient(
	recipient: OrganizationNotificationExtraRecipient,
	organizationIds: readonly string[]
): Promise<OrganizationNotificationRecipient | null> {
	let userId = text(recipient.userId, MAX_ID);
	let email = normalizeEmail(recipient.email);
	if (userId && !email) {
		const user = userSchema
			.nullable()
			.parse(await User.findById(userId).select("email"));
		email = normalizeEmail(user?.email);
	} else if (!userId && email) {
		// Resolve a registered invitee by address so their personal channel
		// preference still applies. Unregistered invitees remain email-only and
		// continue through the required Better Auth invitation path.
		const user = userSchema
			.nullable()
			.parse(await User.findOne({ email }).select("_id"));
		userId = modelId(user?._id, MAX_ID);
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

export function mergeRecipients(
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
