import { randomUUID } from "node:crypto";
import { PlatformInboxNotification } from "@ryu/db/models/inbox-notification.model";
import {
	isOrganizationNotificationEnabled,
	type OrganizationNotificationKind,
} from "@ryu/db/models/organization-notification.model";
import { OrganizationActivityEmail } from "@ryu/email";
import {
	type InboxText,
	inboxEnglish,
} from "@ryu/email/i18n/inbox-messages.ts";
import { organizationActivityCopy } from "@ryu/email/i18n/organization-activity-sources.ts";
import { resolveOrganizationFeatureValues } from "./organization-feature-values.ts";
import { organizationFeatureByKey } from "./organization-features.ts";
import {
	MAX_ID,
	MAX_TEXT,
	mergeRecipients,
	type OrganizationNotificationExtraRecipient,
	type OrganizationNotificationRecipient,
	resolveExtraRecipient,
	resolveOrganizationRecipients,
	safeActionUrl,
	text,
	uniqueStrings,
} from "./organization-notification-recipients.ts";
import {
	deliverUserNotificationEmail,
	shouldStoreUserNotificationInApp,
} from "./user-notification-delivery.ts";

export {
	type OrganizationNotificationExtraRecipient,
	type OrganizationNotificationRecipient,
	resolveOrganizationPermissionRecipients,
	resolveOrganizationRecipients,
} from "./organization-notification-recipients.ts";

/**
 * One organization activity event. `body` and the action labels are
 * finished English or `{ source, values }` message parts (see
 * `@ryu/email/i18n/organization-activity-messages.ts`); the Inbox row stores
 * the parts as `copy` and the email renders them in the recipient's language.
 */
export interface OrganizationNotificationInput {
	actionLabel?: InboxText | null;
	actionLabelForOrganization?:
		| ((organizationId: string) => InboxText | null)
		| undefined;
	actionUrl?: string | null;
	actionUrlForOrganization?:
		| ((organizationId: string) => string | null)
		| undefined;
	body: InboxText;
	dedupeKey: string;
	extraRecipients?: readonly OrganizationNotificationExtraRecipient[];
	kind: OrganizationNotificationKind;
	organizationIds: readonly string[];
	sourceId: string;
	sourceType: string;
	subject: string;
	title: string;
}

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
		const values = await resolveOrganizationFeatureValues({
			keys: [feature.key],
			organizationId,
			userId: userId || null,
		});
		return values.get(feature.key) !== false;
	} catch {
		// Notification delivery remains fail-open when the feature-control store is
		// unavailable, matching the existing transactional notification policy.
		return true;
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

/** The action label for `recipient`, as message parts or bounded English. */
function actionLabelFor(
	input: OrganizationNotificationInput,
	recipient: OrganizationNotificationRecipient
): InboxText | null {
	if (recipient.actionLabelOverride !== undefined) {
		return recipient.actionLabelOverride;
	}
	if (input.actionLabelForOrganization) {
		for (const organizationId of recipient.organizationIds) {
			const label = boundedLabel(
				input.actionLabelForOrganization(organizationId)
			);
			if (label) {
				return label;
			}
		}
	}
	return boundedLabel(input.actionLabel);
}

function boundedLabel(label: InboxText | null | undefined): InboxText | null {
	if (typeof label === "string" || label === null || label === undefined) {
		return text(label, 80) || null;
	}
	return text(inboxEnglish(label), 80) ? label : null;
}

/** Finished English for the stored row and the delivery claim. */
const english = (value: InboxText | null | undefined, max: number): string =>
	text(inboxEnglish(value), max);

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

	const actionLabel = actionLabelFor(input, recipient);
	const actionUrl = actionUrlFor(input, recipient);
	await deliverUserNotificationEmail({
		actionLabel: english(actionLabel, 80) || null,
		actionUrl,
		body: english(input.body, MAX_TEXT),
		dedupeKey: `organization:${text(input.dedupeKey, MAX_ID)}`,
		email: recipient.email,
		kind: input.kind,
		organizationId,
		organizationKind: input.kind,
		react: OrganizationActivityEmail({
			actionLabel,
			actionUrl,
			body:
				typeof input.body === "string"
					? english(input.body, MAX_TEXT)
					: input.body,
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
	const actionLabel = actionLabelFor(input, recipient);
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
				body: english(input.body, MAX_TEXT),
				// The message parts behind each field, so the web Inbox renders
				// the row in the reader's language (rows written before this
				// field keep their English).
				copy: organizationActivityCopy({
					actionLabel,
					body: input.body,
					title: input.title,
				}),
				icon: "building-2",
				color: null,
				actionLabel: english(actionLabel, 80) || null,
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
