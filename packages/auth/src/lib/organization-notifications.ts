import { randomUUID } from "node:crypto";
import { User } from "@ryu/db/models/auth.model";
import { BillingEmailDelivery } from "@ryu/db/models/billing-email.model";
import {
	Member,
	mapBaRole,
	roleSatisfies,
} from "@ryu/db/models/control-plane.model";
import { PlatformInboxNotification } from "@ryu/db/models/inbox-notification.model";
import {
	isOrganizationNotificationEnabled,
	type OrganizationNotificationKind,
} from "@ryu/db/models/organization-notification.model";
import { OrganizationActivityEmail, sendEmail } from "@ryu/email";

const STALE_CLAIM_MS = 15 * 60 * 1000;
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

const text = (value: unknown, max: number): string =>
	typeof value === "string" ? value.trim().slice(0, max) : "";

const normalizeEmail = (value: unknown): string =>
	text(value, MAX_EMAIL).toLowerCase();

const uniqueStrings = (values: readonly string[], max: number): string[] => [
	...new Set(values.map((value) => text(value, max)).filter(Boolean)),
];

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
	organizationIds: readonly string[]
): Promise<OrganizationNotificationRecipient[]> {
	const ids = uniqueStrings(organizationIds, MAX_ID);
	if (ids.length === 0) {
		return [];
	}

	const members = (await Member.find({
		organizationId: { $in: ids },
	}).select("organizationId role userId")) as unknown as MemberLike[];
	const organizationIdsByUser = new Map<string, Set<string>>();
	for (const member of members) {
		const userId = text(member.userId, MAX_ID);
		const organizationId = text(member.organizationId, MAX_ID);
		if (
			!(
				userId &&
				organizationId &&
				roleSatisfies(mapBaRole(text(member.role, 80)), "admin")
			)
		) {
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

async function resolveExtraRecipient(
	recipient: OrganizationNotificationExtraRecipient,
	organizationIds: readonly string[]
): Promise<OrganizationNotificationRecipient | null> {
	const userId = text(recipient.userId, MAX_ID);
	let email = normalizeEmail(recipient.email);
	if (userId && !email) {
		const user = (await User.findById(userId).select(
			"email"
		)) as UserLike | null;
		email = normalizeEmail(user?.email);
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

async function claimEmailDelivery(input: {
	dedupeKey: string;
	kind: string;
	organizationId: string | null;
	recipient: string;
}): Promise<boolean> {
	const now = new Date();
	const staleBefore = new Date(now.getTime() - STALE_CLAIM_MS);
	const reclaimed = await BillingEmailDelivery.findOneAndUpdate(
		{
			dedupeKey: input.dedupeKey,
			$or: [
				{ status: "failed" },
				{ claimedAt: { $lt: staleBefore }, status: "sending" },
			],
		},
		{
			$inc: { attempts: 1 },
			$set: {
				claimedAt: now,
				lastError: null,
				status: "sending",
				updatedAt: now,
			},
		},
		{ new: true }
	);
	if (reclaimed) {
		return true;
	}

	try {
		await BillingEmailDelivery.create({
			claimedAt: now,
			dedupeKey: input.dedupeKey,
			kind: input.kind,
			organizationId: input.organizationId,
			recipient: input.recipient,
			status: "sending",
			updatedAt: now,
		});
		return true;
	} catch (error) {
		if ((error as { code?: number }).code === 11_000) {
			return false;
		}
		throw error;
	}
}

async function sendOrganizationEmail(
	input: OrganizationNotificationInput,
	recipient: OrganizationNotificationRecipient,
	enabledOrganizationIds: ReadonlySet<string>
): Promise<void> {
	if (
		recipient.organizationIds.length > 0 &&
		!recipient.organizationIds.some((id) => enabledOrganizationIds.has(id))
	) {
		return;
	}

	const dedupeKey = `organization:${text(input.dedupeKey, MAX_ID)}:${recipient.email}`;
	const claimed = await claimEmailDelivery({
		dedupeKey,
		kind: input.kind,
		organizationId: recipient.organizationIds[0] ?? null,
		recipient: recipient.email,
	});
	if (!claimed) {
		return;
	}

	const actionUrl = actionUrlFor(input, recipient);
	try {
		await sendEmail({
			react: OrganizationActivityEmail({
				actionLabel: actionLabelFor(input, recipient),
				actionUrl,
				body: text(input.body, MAX_TEXT),
				heading: text(input.title, 140),
				preview: text(input.subject, 180),
			}),
			skipRateLimit: true,
			subject: text(input.subject, 180),
			to: recipient.email,
		});
		await BillingEmailDelivery.updateOne(
			{ dedupeKey },
			{
				$set: {
					lastError: null,
					sentAt: new Date(),
					status: "sent",
					updatedAt: new Date(),
				},
			}
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : "send failed";
		await BillingEmailDelivery.updateOne(
			{ dedupeKey },
			{
				$set: {
					lastError: message.slice(0, MAX_TEXT),
					status: "failed",
					updatedAt: new Date(),
				},
			}
		);
		console.error("[organization-notification] email failed:", message);
	}
}

async function publishOrganizationInboxNotification(
	input: OrganizationNotificationInput,
	recipient: OrganizationNotificationRecipient
): Promise<void> {
	if (!recipient.userId) {
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

		const recipients = await resolveOrganizationRecipients(organizationIds);
		for (const extra of input.extraRecipients ?? []) {
			const resolved = await resolveExtraRecipient(extra, organizationIds);
			if (resolved) {
				mergeRecipients(recipients, resolved);
			}
		}
		if (recipients.length === 0) {
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
			recipients.map(async (recipient) => {
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
