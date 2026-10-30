// apps/desktop/src/lib/api/credits-settings.ts
//
// Auto-recharge and low-balance alert settings shapes for the platform-credits
// client (split from credits.ts).

/**
 * The org's auto-recharge settings as the server returns them
 * (`serializeAutoTopup`). All money fields are integer cents / micro-USD; status
 * fields report the last off-session attempt and the running monthly spend.
 */
export interface AutoTopupSettings {
	amountCents: number;
	consecutiveFailures: number;
	cooldownSec: number;
	enabled: boolean;
	lastAttemptAt: string | null;
	lastError: string | null;
	/** Total auto-recharge charged so far in the current `monthKey`, micro-USD. */
	monthChargedMicroUsd: number;
	/** Calendar-month bucket for {@link monthChargedMicroUsd}, e.g. "2026-07". */
	monthKey: string | null;
	/** Per-calendar-month spend cap in cents; 0 = no cap. */
	monthlyCapCents: number;
	thresholdCents: number;
}

/** The `PUT /autotopup` body: enable/disable + the recharge parameters. */
export interface AutoTopupInput {
	/** Fixed top-up amount charged each recharge, cents (bounds $5–$1000). */
	amountCents: number;
	/** Minimum seconds between off-session charges (server floors at 60). */
	cooldownSec?: number;
	enabled: boolean;
	/** Per-calendar-month spend cap in cents; 0 = no cap. */
	monthlyCapCents?: number;
	/** Recharge fires when the balance falls below this, cents (must be > 0). */
	thresholdCents: number;
}

/** Who is emailed on low balance. Mirrors the server's `CreditAlertRecipients`. */
export type CreditAlertRecipients = "none" | "owners" | "owners_admins";

/** The org's low-balance alert settings as the server returns them. */
export interface CreditAlertSettings {
	/** Non-null once an alert has fired for the current below-threshold episode. */
	belowSince: string | null;
	lastError: string | null;
	notifiedAt: string | null;
	recipients: CreditAlertRecipients;
	thresholdCents: number;
}

/** The `PUT /alert` body: who to email + the balance threshold. */
export interface CreditAlertInput {
	recipients: CreditAlertRecipients;
	/** Alert fires when the balance falls below this, cents (required unless "none"). */
	thresholdCents: number;
}
