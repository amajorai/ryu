import { PLANS } from "./plan-catalog.ts";
import type { PlanId } from "./plan-core.ts";

/** Plan catalog part: Kernel quotas, plan limits and email allowances. Re-exported by `plans.ts`. */

/**
 * What a quota's number counts, so a surface can render it without a lookup
 * table of its own: "5 monitors" vs "30 days" vs "2 GB".
 */
export type QuotaUnit = "count" | "days" | "gigabytes";

/** One numeric quota: what it means, who owns the key, and its per-tier numbers. */
export interface QuotaSpec {
	/** The FREE (null-plan) baseline — the managed starter cap. */
	readonly free: number;
	/** Human label for upgrade prompts and the pricing grid ("Website monitors"). */
	readonly label: string;
	/**
	 * The app id whose manifest declares this key, or `null` when the KERNEL owns
	 * it. A kernel quota is a shell/runtime concern with no app to uninstall, so it
	 * always applies; an app-owned quota applies only while that app is installed
	 * and enabled (the client resolves that — see the desktop `planCapBridge`).
	 */
	readonly owner: string | null;
	/**
	 * Per-plan numbers. A plan absent from this map is UNBOUNDED
	 * ({@link Number.POSITIVE_INFINITY}) — which is the symbolic-cap default, so
	 * only a quota with a real per-tier cost writes a row here.
	 */
	readonly paid?: Partial<Record<PlanId, number>>;
	readonly unit: QuotaUnit;
}

/**
 * Quotas owned by the desktop shell or Core runtime. Marketplace apps, plugins,
 * skills, MCP servers, and workflows are intentionally absent: their catalog
 * price is commerce metadata and must not become a plan-based runtime limit.
 */
export const KERNEL_QUOTAS = {
	maxAgents: {
		free: Number.POSITIVE_INFINITY,
		label: "Agents",
		owner: null,
		unit: "count",
	},
	maxConcurrentRuns: {
		free: Number.POSITIVE_INFINITY,
		label: "Concurrent runs",
		owner: null,
		// Managed execution is protected by entitlement and credit budgets.
		unit: "count",
	},
	maxEvalRunsMonthly: {
		free: Number.POSITIVE_INFINITY,
		label: "Eval runs per month",
		owner: null,
		unit: "count",
	},
	maxOpenTabs: { free: 3, label: "Open tabs", owner: null, unit: "count" },
	maxRemoteNodes: {
		free: 1,
		label: "Remote nodes",
		owner: null,
		unit: "count",
	},
	maxSpaces: {
		free: Number.POSITIVE_INFINITY,
		label: "Spaces",
		owner: null,
		unit: "count",
	},
	spaceStorageLimitGb: {
		free: 1,
		label: "Space storage",
		owner: null,
		// Real storage cost, so finite on paid rows too. EVERY plan id needs a
		// row: an absent plan resolves to Infinity in `planLimit`. A Major Pass
		// adds no hosted storage of its own, so it keeps the free baseline.
		paid: {
			"desktop-license": 20,
			"marketplace-membership": 1,
			// Set 2026-10-20 with the mail allowances (founder decision).
			pro: 10,
			plus: 10,
			max: 50,
			teams: 50,
			"teams-lite": 50,
			business: 50,
		},
		unit: "gigabytes",
	},
} as const satisfies Record<string, QuotaSpec>;

/**
 * Every declared Core quota key. DERIVED from the registry above — never
 * hand-written, and never widened to `string`: call sites pass string literals
 * (`guard("maxSpaces", n)`), so a widened union would keep every one of them
 * compiling while silently losing the typo check that is the point.
 */
export type PlanLimitField = keyof typeof KERNEL_QUOTAS;

/** The single registry of plan quotas that remain after app/plugin access opens. */
export const QUOTAS = {
	...KERNEL_QUOTAS,
} satisfies Readonly<Record<PlanLimitField, QuotaSpec>>;

/** Retained for callers that render quota ownership; remaining keys are Core-owned. */
export const quotaOwner = (field: PlanLimitField): string | null =>
	QUOTAS[field].owner;

/**
 * The FREE (null-plan) baseline for every quota, projected out of {@link QUOTAS}.
 * Kept as an exported record because consumers iterate it; the numbers themselves
 * live on each {@link QuotaSpec}. Read it through {@link planLimit}, never inline.
 */
export const FREE_TIER_LIMITS: Readonly<Record<PlanLimitField, number>> =
	// SAFETY: Every QUOTAS key is projected once to its numeric free allowance.
	Object.fromEntries(
		Object.entries(QUOTAS).map(([field, spec]) => [field, spec.free])
	) as Record<PlanLimitField, number>;

/**
 * The effective numeric limit for `field` on `plan`. A null plan gets the free
 * baseline; a paid plan gets its {@link QuotaSpec.paid} row, defaulting to
 * unbounded. Single source of truth for every count/quota gate — enforce with
 * this, never a literal.
 *
 * This answers "what does this tier allow" for the remaining Core-owned
 * resource limits. Marketplace app/plugin access is not represented here.
 */
export const planLimit = (
	plan: PlanId | null,
	field: PlanLimitField
): number => {
	const spec: QuotaSpec = QUOTAS[field];
	if (!plan) {
		return spec.free;
	}
	return spec.paid?.[plan] ?? Number.POSITIVE_INFINITY;
};

/** Bytes in one gibibyte; the unit the storage cap is expressed against. */
const BYTES_PER_GB = 1024 ** 3;

/** Free baseline hosted-mail storage (GiB), kept small to bound inbound abuse. */
export const FREE_EMAIL_STORAGE_LIMIT_GB = 1;

/** Convert a whole-GiB storage figure to bytes (Infinity stays unbounded). */
export const gibToBytes = (gib: number): number =>
	gib === Number.POSITIVE_INFINITY
		? Number.POSITIVE_INFINITY
		: gib * BYTES_PER_GB;

/**
 * Whether a plan's Agent Inboxes allowance is the free baseline: no plan, or a
 * plan that adds no hosted-mail allowance of its own (A Major Pass, the desktop
 * license). The free baseline is one allowance per person, not per
 * organization; the mail router meters it against the account that owns it.
 */
export const emailUsesFreeBaseline = (plan: PlanId | null): boolean =>
	plan === null || !PLANS[plan].emailEnabled;

/**
 * The total stored-mail cap (in bytes) a plan grants for Agent Inboxes, derived
 * from its {@link Plan.emailStorageLimitGb}. A plan on the free baseline
 * ({@link emailUsesFreeBaseline}) receives the free 1 GiB storage allowance.
 * An unbounded figure ({@link Number.POSITIVE_INFINITY}) maps straight to
 * Infinity (no byte multiply). Single source of truth; never inline the multiply
 * in the mail router.
 */
export const emailStorageLimitBytes = (plan: PlanId | null): number =>
	gibToBytes(
		plan === null || emailUsesFreeBaseline(plan)
			? FREE_EMAIL_STORAGE_LIMIT_GB
			: PLANS[plan].emailStorageLimitGb
	);

/** The Agent Inboxes (Ryu Mail) quota a plan grants. */
export interface EmailQuota {
	/**
	 * Max agent aliases on the owner's mailbox. Free has three; paid plans are
	 * UNLIMITED ({@link Number.POSITIVE_INFINITY}).
	 */
	readonly aliasLimit: number;
	/** Whether Agent Inboxes are available at all on this plan. */
	readonly enabled: boolean;
	/**
	 * Max inboxes the plan may hold. Free has one; paid plans are UNLIMITED
	 * ({@link Number.POSITIVE_INFINITY}); enforcement caps STORAGE, not count.
	 */
	readonly inboxLimit: number;
	/** Max outbound emails per calendar month; each listed recipient is one. */
	readonly monthlySendLimit: number;
	/**
	 * Max total stored Agent Inbox bytes the plan may hold (the real Agent Inbox
	 * cap). {@link Number.POSITIVE_INFINITY} means uncapped; all current plans are
	 * finite.
	 */
	readonly storageLimitBytes: number;
}

/**
 * The free growth-loop allowance. Fifty emails (counted per recipient) is
 * enough for a real agent to reach a small audience without turning a free
 * account into a bulk-mail account. It is intentionally branded, capped to one
 * inbox and three agent aliases, and granted once per person across every
 * organization they own; paid tiers buy materially more volume and storage.
 */
export const EMAIL_QUOTA_FREE: EmailQuota = {
	enabled: true,
	inboxLimit: 1,
	aliasLimit: 3,
	monthlySendLimit: 50,
	storageLimitBytes: emailStorageLimitBytes(null),
};

/**
 * Resolve the Agent Inboxes quota for a plan id. A plan on the free baseline
 * (no plan, A Major Pass, or the desktop license — see
 * {@link emailUsesFreeBaseline}) gets {@link EMAIL_QUOTA_FREE}: buying a
 * product that adds no mail allowance never leaves a customer with less than
 * a free account. The numbers live ONLY in the plan catalog above — never
 * inline them in the mail router or the pricing page (that page's strings are
 * marketing copy; THIS is the enforced limit).
 */
export const emailQuotaForPlan = (plan: PlanId | null): EmailQuota => {
	if (plan === null || emailUsesFreeBaseline(plan)) {
		return EMAIL_QUOTA_FREE;
	}
	const p = PLANS[plan];
	return {
		enabled: p.emailEnabled,
		inboxLimit: p.emailInboxLimit,
		aliasLimit: p.emailAliasLimit,
		monthlySendLimit: p.emailMonthlySendLimit,
		storageLimitBytes: emailStorageLimitBytes(plan),
	};
};

/**
 * Whether a plan may remove the "Sent from Ryu" branding footer from outbound
 * agent email. A null plan (free/trial) can NEVER remove it — free/trial
 * senders are the growth loop. Only paid plans whose catalog flag is set may
 * toggle it off. Single source of truth; never inline the plan check.
 */
export const canRemoveEmailBranding = (plan: PlanId | null): boolean =>
	plan !== null && PLANS[plan].emailBrandingRemovable;

/**
 * Whether a plan drops the "Powered by Ryu" badge Ryu stamps on the public pages
 * it serves for a member: published Sites, Forms respondent pages, public
 * feedback boards, embedded agents and the assistant widget. It is the same growth
 * loop as the email footer and the same catalog flag decides it, so a plan that
 * may unbrand its mail may unbrand its pages and no plan can do one but not the
 * other. Free, trial and one-time desktop licences stay branded.
 */
export const canRemovePoweredByRyu = (plan: PlanId | null): boolean =>
	canRemoveEmailBranding(plan);

/* -------------------------------------------------------------------------- *
 * Hosted service rates (decided 2026-10-12, `docs/service-billing.md`)
 * -------------------------------------------------------------------------- */
