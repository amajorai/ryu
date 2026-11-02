// The published standalone pricing figures and their number formatters.
// `standalone-pricing.ts` re-exports them and builds the pricing copy.

/**
 * The published figures behind every standalone pricing string.
 *
 * The enforced values live elsewhere: deposit fees, hosted-mail allowances, and
 * hosted service rates in `@ryu/auth/lib/plans` (`DEPOSIT_FEE_BPS_BY_PLAN`,
 * `emailQuotaForPlan`, `SERVICE_RATES`, `BOX_SIZE_MICRO_USD_PER_HOUR`), the
 * per-size Box rates Core-created Boxes pay in the Gateway's default size table
 * (`apps/gateway/src/config.rs`, the shared fixture
 * `crates/gateway/contracts/fixtures/box-rates.json`), and the other sandbox
 * backends' per-resource rates in the Gateway sandbox defaults (per-second rate
 * times the sandbox markup).
 * This presentational module does not import the plan catalog at runtime, so
 * the catalog's Polar product ids and env-var names stay out of browser
 * bundles. `standalone-pricing.test.ts` checks this table against both
 * sources, and checks the public pricing docs against this table, so a change
 * on either side fails until the published copy follows it.
 */
export const PUBLISHED_PRICING = {
	depositFee: {
		/** No managed plan, A Major Pass, and the desktop license. */
		baseBps: 2700,
		/** Pro; separately issued individual offers pay this rate too. */
		proBps: 2650,
		/** Max, Teams, and Business; separately issued organization offers too. */
		teamBps: 2600,
		minimumUsd: 5,
		/** Most Ryu keeps from one top-up (`DEPOSIT_MARGIN_CAP_MICRO_USD`). */
		marginCapUsd: 10,
	},
	mail: {
		/** Granted once per person; A Major Pass and the desktop license keep it. */
		free: { inboxes: 1, monthlyEmails: 50, storageGib: 1 },
		/** Pro; separately issued individual offers share it. */
		pro: { monthlyEmails: 5000, storageGib: 10 },
		max: { monthlyEmails: 100_000, storageGib: 100 },
		/** Teams and Business; separately issued organization offers share it. */
		organization: { monthlyEmails: 100_000, storageGib: 20 },
	},
	box: {
		/** Per running hour of each size, billed per minute. */
		smallHourUsd: 0.025,
		defaultHourUsd: 0.04,
		largeHourUsd: 0.07,
		/** Every start (create or resume) is billed for at least this long. */
		minimumMinutesPerStart: 5,
		/**
		 * Per GiB-month (30 days, GiB = 2^30 bytes) of saved Box state and
		 * snapshots above the organization's included storage, while stored.
		 */
		storageGibMonthUsd: 0.05,
		/** Days in the month the storage rate is prorated over. */
		storageMonthDays: 30,
		/** Box storage included per organization: paid plans, and no paid plan. */
		includedStorageGib: { paid: 25, trial: 10 },
	},
	/** Other sandbox backends (not Box), metered per resource. */
	sandbox: {
		vcpuHourUsd: 0.0655,
		memoryGibHourUsd: 0.0211,
		/** Per GiB-month of storage above {@link freeStorageGib}. */
		storageGibMonthUsd: 0.1,
		/** Free storage per sandbox. */
		freeStorageGib: 5,
	},
	notify: {
		eventsPer1000Usd: 0.1,
		/** Per organization per calendar month (UTC). */
		freeEventsPerMonth: 10_000,
	},
	passport: {
		/** Per connection-month (30 days) a stored connection or MCP credential exists. */
		connectionMonthUsd: 0.1,
		freeConnectionMonths: 5,
		fetchesPer1000Usd: 0.1,
		freeFetchesPerMonth: 10_000,
	},
	/**
	 * Hosted Space storage (`spaceStorageLimitGb`), in GB, as the plan cards
	 * print it. Separately issued individual offers share Pro's.
	 */
	spaceStorageGb: {
		pro: 10,
	},
	mailOverage: {
		/** Recipients beyond a paid plan's monthly allowance, from positive credit. */
		recipientsPer1000Usd: 1,
	},
	connect: {
		/**
		 * Toolkit calls a Connect deployment serves itself (natively routed
		 * toolkits). No free allowance; Composio add-ons never apply.
		 */
		nativeCallsPer1000Usd: 0.4,
	},
	/**
	 * The tool spend volume ladder's rungs (`TOOL_SPEND_LADDER`). None are
	 * published: the ladder is disabled pending a pricing decision.
	 */
	toolSpendLadder: [] as readonly {
		readonly discountBps: number;
		readonly fromUsd: number;
		readonly label: string;
	}[],
	/**
	 * Ryu's share of a composed tool's maker fee (`COMPOSED_TOOL_FEES`): none,
	 * pending a commercial decision. Makers set their own fee per run.
	 */
	composedToolPlatformTakeBps: 0,
} as const;

export interface PublishedMailAllowance {
	readonly monthlyEmails: number;
	readonly storageGib: number;
}

const countFormat = new Intl.NumberFormat("en-US");

/** Format a whole count the way pricing copy prints it ("10,000"). */
export function formatCount(value: number): string {
	return countFormat.format(value);
}

/** Format basis points as a percentage ("2650" -> "26.5%"). */
export function formatBps(bps: number): string {
	return `${bps / 100}%`;
}

/** Format a USD amount with a fixed number of decimals ("$0.0655"). */
export function formatUsd(amount: number, fractionDigits = 0): string {
	return `$${amount.toFixed(fractionDigits)}`;
}

/**
 * Format a per-hour rate with as few decimals as it needs, at least two
 * ("$0.025", "$0.04").
 */
export function formatUsdRate(amount: number): string {
	const exact = amount.toFixed(4).replace(/0+$/u, "");
	const decimals = Math.max(2, exact.split(".")[1]?.length ?? 0);
	return formatUsd(amount, decimals);
}

/** "5,000 emails and 10 GiB" for a hosted-mail allowance. */
export function formatMailAllowance(allowance: PublishedMailAllowance): string {
	return `${formatCount(allowance.monthlyEmails)} emails and ${allowance.storageGib} GiB`;
}
