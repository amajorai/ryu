// apps/desktop/src/lib/api/credits-ledger.ts
//
// Ledger reason vocabulary for the platform-credits client (split from credits.ts).

/**
 * Why a ledger entry was written. Mirrors the server's `LedgerReason` in
 * `@ryu/db/models/credits.model`. Ledger entries retain the wire reason string, so
 * newly introduced server reasons keep their existing raw-label fallback.
 * These known reasons define the desktop labels and credit classification.
 */
export type LedgerReason =
	| "topup"
	| "plan_grant"
	| "gateway_usage"
	| "openrouter"
	| "composio"
	| "treg"
	| "subscription_offset"
	| "adjustment"
	| "web_search"
	| "campaign_grant"
	| "referral_grant"
	| "gift_credit"
	| "gift_card"
	| "gift_expired"
	| "gift_reversal"
	| "managed_agents"
	| "box"
	| "sandbox"
	| "notify"
	| "passport"
	| "connect_native"
	| "connect_vendor"
	| "connect_composed"
	| "composed_tool_earnings"
	| "mail"
	| "messaging";

/** Reasons that CREDIT the wallet (positive delta). Mirrors the server's
 * `CREDIT_REASONS`; used so the ledger badges a credit consistently. */
export const CREDIT_LEDGER_REASONS: readonly LedgerReason[] = [
	"topup",
	"plan_grant",
	"campaign_grant",
	"referral_grant",
	"gift_credit",
	"gift_card",
	"composed_tool_earnings",
];

/** Human label for each ledger reason, for the ledger list. */
export const LEDGER_REASON_LABELS = {
	topup: "Top-up",
	plan_grant: "Plan credit",
	gateway_usage: "Gateway usage",
	openrouter: "OpenRouter usage",
	composio: "Composio action",
	treg: "Treg tool",
	subscription_offset: "Subscription offset",
	adjustment: "Adjustment",
	web_search: "Web search",
	// Campaign and referral money is POOL-RESTRICTED, but the label deliberately
	// does not say which pool: the pool is a supply-side fact, and the user-facing
	// promise is one Ryu-native unit. The per-pool breakdown lives on the balance
	// card, not on every ledger row.
	campaign_grant: "Campaign credit",
	referral_grant: "Referral credit",
	gift_credit: "Gift credits",
	gift_card: "Gift card",
	gift_expired: "Gift credits expired",
	gift_reversal: "Gift credit reversal",
	managed_agents: "Managed Agents",
	// Hosted standalone services, settled hourly from each service's usage.
	box: "Box compute and storage",
	// A session's Box on a node, metered per tick by the Gateway while it runs.
	sandbox: "Box session compute",
	notify: "Notify events",
	passport: "Passport connections and fetches",
	connect_native: "Connect tool call",
	connect_vendor: "Connect vendor call (Ryu key)",
	connect_composed: "Composed tool fee",
	composed_tool_earnings: "Composed tool earnings",
	mail: "Mail overage",
	messaging: "Messaging (SMS, WhatsApp, voice)",
} satisfies Record<LedgerReason, string>;

/** Preserve the server reason fallback when a future ledger reason is introduced. */
export function ledgerReasonLabel(reason: string) {
	return Object.entries(LEDGER_REASON_LABELS).find(
		([key]) => key === reason
	)?.[1];
}
export function isCreditLedgerReason(reason: string) {
	return CREDIT_LEDGER_REASONS.some((known) => known === reason);
}
