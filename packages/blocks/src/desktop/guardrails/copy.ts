// Shared option lists and labels for the guardrail editors.

import {
	GUARDRAIL_ALERT_TIERS,
	type GuardrailAlertTier,
	type GuardrailFirewallAction,
	type GuardrailPatternKind,
} from "./types.ts";

/** Firewall action options with a one-clause explanation each. */
export const GUARDRAIL_ACTION_OPTIONS: {
	label: string;
	value: GuardrailFirewallAction;
}[] = [
	{ value: "block", label: "Block: reject with 403" },
	{ value: "warn_and_continue", label: "Warn and continue: log only" },
	{ value: "sanitize", label: "Sanitize: redact detected patterns" },
];

/** Short names for firewall actions, for inline copy. */
export const GUARDRAIL_ACTION_LABELS = {
	block: "Block",
	warn_and_continue: "Warn and continue",
	sanitize: "Sanitize",
} satisfies Record<GuardrailFirewallAction, string>;

/** Short tier names, for inline summaries. */
export const GUARDRAIL_ALERT_TIER_LABELS = {
	silent: "Silent",
	warn: "Warn",
	fanout: "Fanout",
	email: "Email",
} satisfies Record<GuardrailAlertTier, string>;

/** What each tier delivers, as a mid-sentence clause. */
const ALERT_TIER_DESCRIPTIONS = {
	silent: "No notification (default)",
	warn: "In-app notification only",
	fanout: "Webhook, Telegram, and mobile push",
	email: "Email recipients only (instead of the fan-out channels)",
} satisfies Record<GuardrailAlertTier, string>;

/** `Label: clause` options, ascending in severity. */
export const GUARDRAIL_ALERT_TIER_OPTIONS: {
	label: string;
	value: GuardrailAlertTier;
}[] = GUARDRAIL_ALERT_TIERS.map((tier) => ({
	value: tier,
	label: `${GUARDRAIL_ALERT_TIER_LABELS[tier]}: ${ALERT_TIER_DESCRIPTIONS[tier]}`,
}));

export const GUARDRAIL_PATTERN_KIND_OPTIONS: {
	label: string;
	value: GuardrailPatternKind;
}[] = [
	{ value: "pii", label: "PII" },
	{ value: "secret", label: "Secret" },
	{ value: "prompt_injection", label: "Prompt injection" },
];

/** Best-effort client-side regex validity hint (browser engine, not Rust). */
export function isValidJsRegex(source: string): boolean {
	if (source.length === 0) {
		return true;
	}
	try {
		return Boolean(new RegExp(source));
	} catch {
		return false;
	}
}
