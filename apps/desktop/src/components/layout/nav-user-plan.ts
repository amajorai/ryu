// Plan and upsell labels for the account menu.

import { translateMessage } from "@ryu/i18n/lite";
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
	// No plan is "Free". The desktop has no trial, so `trialing` is only for a
	// caller that knows of one; the chip then reads through the keyed
	// `plans.trialTier`, because the bare catalog
	// "Trial" is an agent lifecycle stage (de "Test").
	return trialing ? translateMessage("plans.trialTier", {}, "Trial") : "Free";
}

// The single next-tier upsell shown in the account menu. Ladder: Plus → Pro,
// Pro/Lifetime → Max, Max → Teams, Teams → nothing (top of the public ladder).
// Plus is private, so no plan defaults to Pro. A free desktop is never shown
// the pitch (see `showUpsell` in NavUser).
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

/**
 * Whether the account menu offers "Get Lifetime Access". Lifetime is an
 * individual plan, so it is listed only while `billing.individual_plans` is on
 * (the web pricing page and the billing router apply the same rule), never
 * to a free desktop (no upsell), and never to someone who already owns it.
 */
export function offerLifetimeAccess(input: {
	individualPlansEnabled: boolean;
	isLifetime: boolean;
	showUpsell: boolean;
}): boolean {
	return input.individualPlansEnabled && input.showUpsell && !input.isLifetime;
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
