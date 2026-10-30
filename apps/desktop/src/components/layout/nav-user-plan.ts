// Plan, trial and upsell labels for the account menu.

import type { LiteralMessage } from "@ryu/i18n/react";

import { formatDate as formatDateInZone } from "@/src/lib/timezone.ts";

const PLAN_LABELS = new Map([
	["desktop-license", "Ryu Desktop"],
	["marketplace-membership", "A Major Pass"],
	["pro", "Ryu Pro"],
	["plus", "Ryu Plus"],
	["max", "Ryu Max"],
	["teams", "Ryu Teams"],
	["teams-lite", "Ryu Teams Lite"],
]);

export function planLabel(
	plan: string | null | undefined,
	trialing: boolean
): string {
	if (plan) {
		return PLAN_LABELS.get(plan) ?? plan;
	}
	// Only a running trial is labelled "Trial"; beta (trial rollout off) is Free.
	return trialing ? "Trial" : "Free";
}

export function trialDaysLabel(days: number, tl: LiteralMessage): string {
	return tl("{days, plural, one {# day left} other {# days left}}", { days });
}

export function showTrialCountdown(
	verdict: { reason: string; daysLeftInTrial: number } | null | undefined
): verdict is { reason: "trial"; daysLeftInTrial: number } {
	return verdict?.reason === "trial" && verdict.daysLeftInTrial > 0;
}

// The single next-tier upsell shown in the account menu. Ladder: Free/Trial →
// Pro, Plus → Pro, Pro/Lifetime → Max, Max → Teams, Teams → nothing (top of
// the public ladder). Plus is private, so Free/Trial still defaults to Pro.
// Trial resolves currentPlan to null (proUnlocked, plan null), so it falls to
// the "Upgrade to Pro" default — the conversion pitch the trial should push.
export function nextTierName(plan: string | null | undefined): string | null {
	if (plan === "teams") {
		return null;
	}
	if (plan === "teams-lite" || plan === "max") {
		return "Teams";
	}
	if (plan === "pro" || plan === "desktop-license") {
		return "Max";
	}
	return "Pro";
}

export function nextTierLabel(
	plan: string | null | undefined,
	tl: LiteralMessage
): string | null {
	const tier = nextTierName(plan);
	return tier ? tl("Upgrade to {tier}", { tier }) : null;
}

export function formatDate(value: string | null | undefined): string {
	if (!value) {
		return "Not scheduled";
	}
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		return "Not scheduled";
	}
	return formatDateInZone(date, {
		year: "numeric",
		month: "short",
		day: "numeric",
	});
}
