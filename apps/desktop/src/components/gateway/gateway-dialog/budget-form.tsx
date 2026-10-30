import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { budgetUsdToMicroUsd } from "@/src/components/gateway/budget-copy.ts";
import type {
	BudgetAction,
	BudgetChargeInclusion,
	BudgetRule,
	GatewayAlertTier,
} from "@/src/lib/api/gateway.ts";
import {
	ALERT_TIERS,
	buildBudgetRule,
	DEFAULT_BUDGET_INCLUSION,
} from "@/src/lib/api/gateway.ts";

export const ACTION_LABELS = {
	notify: "Notify",
	downgrade: "Downgrade",
	restrict: "Restrict",
	stop: "Stop (402)",
} satisfies Record<BudgetAction, string>;

export const ACTION_DESCRIPTIONS = {
	notify: "Allow but flag in metrics",
	downgrade: "Switch to a cheaper model",
	restrict: "Cap max_tokens and strip tools",
	stop: "Reject with 402 budget_exceeded",
} satisfies Record<BudgetAction, string>;

// ── Alert tier copy (shared by the budget dialogs and the guardrails card) ────
//
// ONE source for the wording, in two maps: a short name (for a locked-field
// summary or an "Inherit (…)" label) and a clause saying what the tier actually
// delivers. Every option list below is derived from them, so the four tiers
// cannot end up described one way in Budgets and another in Safety filters.
//
// The clauses are Core's behaviour, read out of the one function that turns a tier
// into sinks: `dispatch` in `apps/core/src/policy_alerts/mod.rs`. `email` sends to
// the node's email recipients INSTEAD OF the webhook/Telegram/push targets, because
// Core's tier match arms are exclusive. The gateway's `AlertTier` doc used to claim
// "fan out AND send email" — it has since been corrected and now agrees, but read
// `dispatch` rather than either comment if this copy ever needs changing.

/** Short tier names, for inline summaries. */
export const ALERT_TIER_LABELS = {
	silent: "Silent",
	warn: "Warn",
	fanout: "Fanout",
	email: "Email",
} satisfies Record<GatewayAlertTier, string>;

/** What each tier delivers, as a mid-sentence clause. */
const ALERT_TIER_DESCRIPTIONS = {
	silent: "No notification (default)",
	warn: "In-app notification only",
	fanout: "Webhook, Telegram, and mobile push",
	email: "Email recipients only (instead of the fan-out channels)",
} satisfies Record<GatewayAlertTier, string>;

/** `Label — clause` options, ascending in severity (the Rust `Ord` order). */
const ALERT_TIER_OPTIONS: { value: GatewayAlertTier; label: string }[] =
	ALERT_TIERS.map((tier) => ({
		value: tier,
		label: `${ALERT_TIER_LABELS[tier]} — ${ALERT_TIER_DESCRIPTIONS[tier]}`,
	}));

/**
 * The dependency this control cannot satisfy on its own, said once and reused by
 * both surfaces: the tier chooses a delivery CHANNEL, and the channel's targets
 * (SMTP transport, recipients, webhook/Telegram/push) are node settings edited on
 * the "Email & alerts" pane. Raising the tier with no targets configured delivers
 * nothing beyond the in-app notification.
 */
export const ALERT_TIER_TARGETS_NOTE =
	"Anything above Silent needs delivery targets: Fanout uses this node's webhook / Telegram / push targets, Email its recipient list. Both are configured under Email & alerts.";

export interface BudgetFormState {
	action: BudgetAction;
	agentId: string;
	/** Notification tier for this rule. Round-trips, so an edit cannot demote it. */
	alert: GatewayAlertTier;
	downgrade_to: string;
	include: BudgetChargeInclusion;
	limitUsd: string;
	restrict_max_tokens: string;
}

export const DEFAULT_FORM: BudgetFormState = {
	agentId: "",
	include: { ...DEFAULT_BUDGET_INCLUSION },
	limitUsd: "1.00",
	action: "notify",
	alert: "silent",
	downgrade_to: "",
	restrict_max_tokens: "256",
};

/**
 * The single form → wire mapping for budget rules. Was duplicated verbatim in
 * `BudgetsCard` and `BudgetScopeSection`; both copies built a fresh literal that
 * carried only limit/action/downgrade_to/restrict_max_tokens, so every save
 * dropped the rule's `alert` tier (and `PUT /v1/config` replaces the whole
 * `BudgetConfig`, so "dropped" meant "reset to silent"). Numeric/trim handling
 * lives in {@link buildBudgetRule} so it is unit-testable without React.
 */
export function formToRule(form: BudgetFormState): BudgetRule {
	return buildBudgetRule({
		limit: budgetUsdToMicroUsd(form.limitUsd) ?? 0,
		action: form.action,
		alert: form.alert,
		downgradeTo: form.downgrade_to,
		include: form.include,
		restrictMaxTokens: form.restrict_max_tokens,
	});
}

/**
 * Inherit-free tier Select, used by both budget dialogs. Kept next to the copy
 * maps so a new tier only has to be added to {@link ALERT_TIERS}.
 */
export function AlertTierSelect({
	id,
	value,
	onChange,
}: {
	id: string;
	value: GatewayAlertTier;
	onChange: (next: GatewayAlertTier) => void;
}) {
	// No `disabled` prop: both call sites are inside a budget editor whose other
	// selects (`budget-action`, `session-budget-action`) are always enabled too —
	// the permission gate on those surfaces is on the Save button, not the fields.
	return (
		<Select
			items={ALERT_TIER_OPTIONS}
			onValueChange={(v) => {
				if (v) {
					onChange(v);
				}
			}}
			value={value}
		>
			<SelectTrigger id={id}>
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				{ALERT_TIER_OPTIONS.map((opt) => (
					<SelectItem key={opt.value} value={opt.value}>
						<span className="font-medium">{ALERT_TIER_LABELS[opt.value]}</span>
						<span className="ml-1 text-muted-foreground text-xs">
							— {ALERT_TIER_DESCRIPTIONS[opt.value]}
						</span>
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}
