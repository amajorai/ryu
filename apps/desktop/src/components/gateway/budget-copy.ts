import { formatCurrency } from "@ryu/ui/lib/number-format.ts";
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

/** Gateway budget amounts are charged micro-USD on the wire. */
export const MICRO_USD_PER_DOLLAR = 1_000_000;

/** Format a charged budget amount for a human-facing desktop label. */
export function formatBudgetUsd(microUsd: number): string {
	if (microUsd > 0 && microUsd < 10_000) {
		return "<$0.01";
	}
	return formatCurrency(microUsd / MICRO_USD_PER_DOLLAR, "USD", {
		maximumFractionDigits: 2,
		minimumFractionDigits: 2,
	});
}

/** Convert a decimal USD form value into the integer wire unit. */
export function budgetUsdToMicroUsd(value: string): number | null {
	const normalized = value.trim();
	if (!/^\d+(?:\.\d{0,6})?$/.test(normalized)) {
		return null;
	}
	const [wholePart, fractionPart = ""] = normalized.split(".");
	const whole = Number(wholePart);
	const fraction = Number(`${fractionPart}000000`.slice(0, 6));
	const microUsd = whole * MICRO_USD_PER_DOLLAR + fraction;
	return Number.isSafeInteger(microUsd) ? microUsd : null;
}

/** Keep up to six decimal places when seeding a USD input from the wire. */
export function microUsdToBudgetInput(microUsd: number): string {
	if (!Number.isSafeInteger(microUsd) || microUsd < 0) {
		return "0";
	}
	const whole = Math.floor(microUsd / MICRO_USD_PER_DOLLAR);
	const fraction = microUsd % MICRO_USD_PER_DOLLAR;
	if (fraction === 0) {
		return String(whole);
	}
	return `${whole}.${String(fraction).padStart(6, "0").replace(/0+$/, "")}`;
}

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

/** Short tier names, for inline summaries. */
export const ALERT_TIER_LABELS = {
	silent: "Silent",
	warn: "Warn",
	fanout: "Fanout",
	email: "Email",
} satisfies Record<GatewayAlertTier, string>;

/** What each tier delivers, as a mid-sentence clause. */
export const ALERT_TIER_DESCRIPTIONS = {
	silent: "No notification (default)",
	warn: "In-app notification only",
	fanout: "Webhook, Telegram, and mobile push",
	email: "Email recipients only (instead of the fan-out channels)",
} satisfies Record<GatewayAlertTier, string>;

/** `Label — clause` options, ascending in severity. */
export const ALERT_TIER_OPTIONS: {
	value: GatewayAlertTier;
	label: string;
}[] = ALERT_TIERS.map((tier) => ({
	value: tier,
	label: `${ALERT_TIER_LABELS[tier]} — ${ALERT_TIER_DESCRIPTIONS[tier]}`,
}));

export const ALERT_TIER_TARGETS_NOTE =
	"Anything above Silent needs delivery targets: Fanout uses this node's webhook / Telegram / push targets, Email its recipient list. Both are configured under Email & alerts.";

export interface BudgetFormState {
	action: BudgetAction;
	agentId: string;
	/** Notification tier for this rule. Round-trips, so an edit cannot demote it. */
	alert: GatewayAlertTier;
	downgrade_to: string;
	include: BudgetChargeInclusion;
	/** Decimal USD form value; the wire rule stores integer micro-USD. */
	limitUsd: string;
	restrict_max_tokens: string;
}

export const DEFAULT_BUDGET_FORM: BudgetFormState = {
	agentId: "",
	include: { ...DEFAULT_BUDGET_INCLUSION },
	limitUsd: "1.00",
	action: "notify",
	alert: "silent",
	downgrade_to: "",
	restrict_max_tokens: "256",
};

/** Convert the shared budget form state into the Gateway wire shape. */
export function budgetFormToRule(form: BudgetFormState) {
	return buildBudgetRule({
		limit: budgetUsdToMicroUsd(form.limitUsd) ?? 0,
		action: form.action,
		alert: form.alert,
		downgradeTo: form.downgrade_to,
		include: form.include,
		restrictMaxTokens: form.restrict_max_tokens,
	});
}

/** Seed the shared form from a stored rule without losing its alert tier. */
export function budgetRuleToForm(
	agentId: string,
	rule?: BudgetRule | null
): BudgetFormState {
	return {
		...DEFAULT_BUDGET_FORM,
		agentId,
		...(rule
			? {
					include: {
						...DEFAULT_BUDGET_INCLUSION,
						...rule.include,
					},
					limitUsd: microUsdToBudgetInput(rule.limit),
					action: rule.action,
					alert: rule.alert ?? "silent",
					downgrade_to: rule.downgrade_to ?? "",
					restrict_max_tokens: String(rule.restrict_max_tokens ?? 256),
				}
			: undefined),
	};
}
