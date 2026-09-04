import { User } from "@ryu/db/models/auth.model";
import { BillingEmailDelivery } from "@ryu/db/models/billing-email.model";
import {
	isOrganizationNotificationEnabled,
	type OrganizationNotificationKind,
} from "@ryu/db/models/organization-notification.model";
import {
	isUserNotificationChannelEnabled,
	type UserNotificationChannel,
} from "@ryu/db/models/user-notification.model";
import { type EmailOptions, PlatformInboxEmail, sendEmail } from "@ryu/email";

const STALE_CLAIM_MS = 15 * 60 * 1000;
const MAX_EMAIL = 320;
const MAX_ID = 300;
const MAX_TEXT = 600;

interface UserLike {
	_id?: unknown;
	email?: unknown;
}

export interface UserNotificationEmailInput {
	actionLabel?: string | null;
	actionUrl?: string | null;
	body: string;
	dedupeKey: string;
	email?: string | null;
	kind: string;
	organizationId?: string | null;
	organizationKind?: OrganizationNotificationKind;
	/** A richer producer-specific template; the generic Inbox template is the default. */
	react?: EmailOptions["react"];
	subject: string;
	userId?: string | null;
}

const text = (value: unknown, max: number): string =>
	typeof value === "string" ? value.trim().slice(0, max) : "";

const normalizeEmail = (value: unknown): string =>
	text(value, MAX_EMAIL).toLowerCase();

function safeActionUrl(value: unknown): string | null {
	const candidate = text(value, MAX_TEXT);
	if (!candidate) {
		return null;
	}
	if (candidate.startsWith("/")) {
		try {
			const url = new URL(candidate, "https://ryu.local");
			return url.origin === "https://ryu.local" ? candidate : null;
		} catch {
			return null;
		}
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

async function resolveEmail(
	userId: string | null,
	providedEmail: string | null | undefined
): Promise<string> {
	const provided = normalizeEmail(providedEmail);
	if (provided) {
		return provided;
	}
	if (!userId) {
		return "";
	}
	const user = (await User.findById(userId).select("email")) as UserLike | null;
	return normalizeEmail(user?.email);
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

/**
 * Deliver one server-generated event to email after both organization and user
 * policy have allowed it. The delivery ledger makes retries idempotent and the
 * function contains provider failures so a business write is never rolled back
 * because mail is unavailable.
 */
export async function deliverUserNotificationEmail(
	input: UserNotificationEmailInput
): Promise<boolean> {
	const userId = text(input.userId, MAX_ID) || null;
	const organizationId = text(input.organizationId, MAX_ID) || null;
	if (
		organizationId &&
		input.organizationKind &&
		!(await isOrganizationNotificationEnabled(
			organizationId,
			input.organizationKind
		))
	) {
		return false;
	}
	if (
		userId &&
		!(await isUserNotificationChannelEnabled(userId, input.kind, "email"))
	) {
		return false;
	}

	const recipient = await resolveEmail(userId, input.email);
	const subject = text(input.subject, 180);
	const body = text(input.body, MAX_TEXT);
	if (!(recipient && subject && body)) {
		return false;
	}

	const dedupeKey = `inbox:${text(input.dedupeKey, MAX_ID)}:${userId ?? recipient}`;
	if (
		!(await claimEmailDelivery({
			dedupeKey,
			kind: text(input.kind, 120),
			organizationId,
			recipient,
		}))
	) {
		return false;
	}

	try {
		await sendEmail({
			react:
				input.react ??
				PlatformInboxEmail({
					actionLabel: text(input.actionLabel, 80) || null,
					actionUrl: safeActionUrl(input.actionUrl),
					body,
					heading: subject,
					preview: subject,
				}),
			skipRateLimit: true,
			subject,
			to: recipient,
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
		return true;
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
		console.error("[user-notification] email failed:", message);
		return false;
	}
}

/** Whether a new platform-Inbox row should be created for this user. */
export function shouldStoreUserNotificationInApp(
	userId: string,
	kind: string,
	category?: string
): Promise<boolean> {
	return isUserNotificationChannelEnabled(userId, kind, "inbox", category);
}

/** Exposed for producer tests and delivery adapters that need the same channel gate. */
export function userNotificationChannelEnabled(
	userId: string,
	kind: string,
	channel: UserNotificationChannel,
	category?: string
): Promise<boolean> {
	return isUserNotificationChannelEnabled(userId, kind, channel, category);
}
