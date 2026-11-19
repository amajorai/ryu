import { createHash } from "node:crypto";
import { EmailCooldown } from "@ryu/db/models/email-cooldown.model";
import { isDuplicateKeyError } from "@ryu/db/native-duplicate-key";
import normalizeEmail from "validator/lib/normalizeEmail.js";
import { z } from "zod";

// The per-recipient cooldown for authentication email: one claim per address
// per minute and 20 a day, in two separate budgets.
//
// - "request": mail anyone can ask for by address without signing in (sign-in
//   links and codes, resets, verification). Keyed by the normalized mailbox,
//   so every alias shares it.
// - "account": mail only a signed-in or password-verified caller can cause
//   (2FA codes, the email sign-in factor, step-up, email change, security
//   notices). Keyed by the exact address of the account it goes to.
//
// - "third-party": mail a signed-in user causes to an address that is not
//   theirs (the new address of an email change). Keyed by the exact address.
//
// A stranger can spend a mailbox's request budget, never its account budget,
// so exhausting the one never blocks the other. Rows are keyed by a hash of
// the budget and address and never look at the user collection, so an
// address nobody registered (or a banned account's) is counted and refused
// exactly like any other: a refusal cannot tell a caller whether an account
// exists.

export const EMAIL_COOLDOWN_MS = 60_000;
export const EMAIL_DAILY_LIMIT = 20;
const ROW_LIFETIME_MS = 24 * 60 * 60 * 1000;
const MAX_ADDRESS_LENGTH = 320;

export type EmailBudget = "request" | "account" | "third-party";

export type EmailCooldownResult =
	| { allowed: true; release?: () => Promise<void> }
	| { allowed: false; reason: "cooldown" | "daily-limit"; retryAfter: number };

/**
 * The address the cooldown counts, or null for one it cannot count. Trimmed,
 * lowercased and put through the same normalizer as the email-harmony plugin
 * (lib/email-harmony.ts), which answers a provider alias (`a.b+x@gmail.com`)
 * as the account it normalizes to. Keying on anything less would let aliases
 * of a registered address share a cooldown while those of an unknown one did
 * not, and that difference would itself reveal the account.
 */
export function emailCooldownAddress(email: string): string | null {
	const trimmed = email.trim();
	if (!trimmed || trimmed.length > MAX_ADDRESS_LENGTH) {
		return null;
	}
	const normalized = normalizeEmail(trimmed);
	return typeof normalized === "string" && normalized
		? normalized
		: trimmed.toLowerCase();
}

/** The exact address, trimmed and lowercased, or null for an unusable one. */
function plainAddress(email: string): string | null {
	const trimmed = email.trim();
	return trimmed && trimmed.length <= MAX_ADDRESS_LENGTH
		? trimmed.toLowerCase()
		: null;
}

/** The address a budget counts: the mailbox for requests, else the address. */
function budgetAddress(budget: EmailBudget, email: string): string | null {
	return budget === "request"
		? emailCooldownAddress(email)
		: plainAddress(email);
}

/** The row key for `email` in `budget`, or null for an unusable address. */
export function emailCooldownKey(
	budget: EmailBudget,
	email: string
): string | null {
	const address = budgetAddress(budget, email);
	return address
		? createHash("sha256").update(`${budget}:${address}`).digest("hex")
		: null;
}

function startOfDay(now: Date): Date {
	const day = new Date(now);
	day.setHours(0, 0, 0, 0);
	return day;
}

const storedRowSchema = z.object({
	dailyCount: z.number(),
	dayStart: z.date(),
	lastSentAt: z.date(),
});

/** The refusal for a claim that lost: the cooldown's remainder, or the day's. */
async function refusal(
	key: string,
	now: Date
): Promise<Extract<EmailCooldownResult, { allowed: false }>> {
	const today = startOfDay(now);
	const row = storedRowSchema.safeParse(
		await EmailCooldown.findById(key)
			.select("dailyCount dayStart lastSentAt")
			.lean()
	);
	if (
		row.success &&
		row.data.dayStart.getTime() === today.getTime() &&
		row.data.dailyCount >= EMAIL_DAILY_LIMIT
	) {
		const tomorrow = new Date(today);
		tomorrow.setDate(tomorrow.getDate() + 1);
		return {
			allowed: false,
			reason: "daily-limit",
			retryAfter: Math.max(
				1,
				Math.ceil((tomorrow.getTime() - now.getTime()) / 1000)
			),
		};
	}
	const lastSentAt = row.success
		? row.data.lastSentAt.getTime()
		: now.getTime();
	return {
		allowed: false,
		reason: "cooldown",
		retryAfter: Math.max(
			1,
			Math.ceil((lastSentAt + EMAIL_COOLDOWN_MS - now.getTime()) / 1000)
		),
	};
}

/**
 * Claim the address's next send in `budget`. One conditional upsert decides
 * it, so concurrent requests for one address cannot both pass: the loser
 * either misses the filter or collides with the winner's insert (duplicate
 * key). A claim made while answering a request is never released (the
 * caller answers before it knows whether any mail goes out, and an unknown
 * address sends nothing); a send's own claim can be given back when the
 * delivery fails. Store errors propagate; each caller decides how to fail.
 */
export async function claimEmailCooldown(
	email: string,
	budget: EmailBudget
): Promise<EmailCooldownResult> {
	const key = emailCooldownKey(budget, email);
	if (!key) {
		return { allowed: true };
	}
	const now = new Date();
	const today = startOfDay(now);
	// Start a new day's count as its own conditional write, so the claim
	// below compares against today's count rather than an earlier day's.
	await EmailCooldown.updateOne(
		{ _id: key, dayStart: { $ne: today } },
		{ $set: { dailyCount: 0, dayStart: today } }
	);
	let claimed = false;
	try {
		claimed = Boolean(
			await EmailCooldown.findOneAndUpdate(
				{
					_id: key,
					dailyCount: { $lt: EMAIL_DAILY_LIMIT },
					lastSentAt: { $lte: new Date(now.getTime() - EMAIL_COOLDOWN_MS) },
				},
				{
					$inc: { dailyCount: 1 },
					$set: {
						dayStart: today,
						expiresAt: new Date(now.getTime() + ROW_LIFETIME_MS),
						lastSentAt: now,
					},
				},
				{ new: true, upsert: true }
			)
		);
	} catch (error) {
		if (!isDuplicateKeyError(error)) {
			throw error;
		}
	}
	if (!claimed) {
		return await refusal(key, now);
	}
	return {
		allowed: true,
		// Give back a claim whose email was never delivered, while it is still
		// the latest one. The stamp it replaced was already outside the
		// cooldown (the claim required it), so the epoch blocks no less.
		release: async () => {
			await EmailCooldown.updateOne(
				{
					_id: key,
					dailyCount: { $gt: 0 },
					dayStart: today,
					lastSentAt: now,
				},
				{ $inc: { dailyCount: -1 }, $set: { lastSentAt: new Date(0) } }
			);
		},
	};
}
