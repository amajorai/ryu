import {
	ladderDisclosure,
	TOOL_SPEND_LADDER_VERSION,
	type ToolSpendLadder,
	toolSpendLadderSchema,
} from "@ryuhq/protocol/tool-spend-ladder";
import { BOX_STORAGE_MICRO_USD_PER_GIB_MONTH } from "./plan-limits.ts";

/** Plan catalog part: Hosted-service meter rates: Box, tool spend and composed tool fees. Re-exported by `plans.ts`. */

/** Seconds in the 30-day month that every per-month service rate is defined over. */
export const SERVICE_BILLING_MONTH_SECONDS = 30 * 24 * 60 * 60;

/**
 * One metered unit of a Ryu-hosted service: `microUsd` for every `perUnits`
 * units, after `freePerMonth` units per organization per calendar month (UTC).
 * Integer-only so a charge is exact before its single round-up.
 */
export interface ServiceMeterRate {
	readonly freePerMonth: number;
	readonly microUsd: number;
	readonly perUnits: number;
}

/** The three Box sizes, as every Box rate table names them. */
export const BOX_SIZES = ["small", "default", "large"] as const;
/** A Box size (`apps/box/src/contracts.ts` `BoxSize`). */
export type BoxRateSize = (typeof BOX_SIZES)[number];

/**
 * The customer price of a running Box per hour, by size, in micro-USD
 * (founder sign-off 2026-10-20, docs/box-per-session-desktop.md §11):
 * small $0.025, default $0.04, large $0.07.
 *
 * Every Box price reads these numbers, and each side's tests read the shared
 * fixture `crates/gateway/contracts/fixtures/box-rates.json`: the Gateway's
 * default size rates (Core-created Boxes, billed by sandbox ticks), Core's
 * credit pre-flight (through the Gateway's quote), the settlement of dashboard
 * and API Boxes, the core-tenant reconciliation, and the Box service's
 * fallback-loss revenue.
 */
export const BOX_SIZE_MICRO_USD_PER_HOUR = Object.freeze({
	small: 25_000,
	default: 40_000,
	large: 70_000,
} as const satisfies Record<BoxRateSize, number>);

/**
 * Every start of a Box (a create or a resume) is billed for at least this
 * many seconds, and each running interval is rounded up to whole
 * {@link BOX_BILLING_ROUNDING_SECONDS}.
 */
export const BOX_MINIMUM_SECONDS_PER_START = 300;
/** A Box's running interval is billed in whole minutes, rounded up. */
export const BOX_BILLING_ROUNDING_SECONDS = 60;

/**
 * Billable seconds of one running interval of `seconds`: rounded up to whole
 * minutes, and never less than the per-start minimum. A start that ran for 0
 * seconds still bills the minimum.
 */
export function boxBillableSeconds(seconds: number): number {
	const whole = Math.max(0, Math.ceil(seconds));
	const rounded =
		Math.ceil(whole / BOX_BILLING_ROUNDING_SECONDS) *
		BOX_BILLING_ROUNDING_SECONDS;
	return Math.max(BOX_MINIMUM_SECONDS_PER_START, rounded);
}

/**
 * The shared-plan pricing ladder for tool spend (Treg parity C6, contract
 * `@ryuhq/protocol/tool-spend-ladder`): volume rungs over an organization's
 * calendar-month tool spend. Disabled with no rungs: whether Ryu offers
 * volume pricing on tool calls, at which thresholds and discounts, is a
 * pending commercial decision, and nothing here may be enabled before it is
 * recorded in `decision`. `PUBLISHED_PRICING.toolSpendLadder` must disclose
 * exactly `toolSpendLadderDisclosure()` (empty while disabled);
 * `standalone-pricing.test.ts` fails until the two agree. Settlement does not
 * read it yet: enabling it also needs a month-to-date tool spend source in
 * `service-usage-settlement.ts`.
 */
export const TOOL_SPEND_LADDER: ToolSpendLadder = toolSpendLadderSchema.parse({
	appliesTo: [],
	decision: {
		decidedOn: null,
		note: "No volume pricing for tool calls is decided; tool calls are charged at their published per-call prices.",
		status: "pending",
	},
	enabled: false,
	rungs: [],
	version: TOOL_SPEND_LADDER_VERSION,
});

/** The ladder rungs a pricing page must disclose, in published units. */
export function toolSpendLadderDisclosure(): {
	discountBps: number;
	fromUsd: number;
	label: string;
}[] {
	return ladderDisclosure(TOOL_SPEND_LADDER).map((rung) => ({
		discountBps: rung.discountBps,
		fromUsd: rung.fromMicroUsd / 1_000_000,
		label: rung.label,
	}));
}

/**
 * Fees on composed tools (Treg parity C7). A maker sets a per-run fee on a
 * composed tool in Connect; the caller pays it once per completed run
 * (ledger reason `connect_composed`) and settlement credits the maker's
 * organization with it less the platform take (`composed_tool_earnings`).
 * The platform take is 0: whether composed-tool sales carry a platform share,
 * and when makers can withdraw earned credit, are pending commercial
 * decisions, and nothing above 0 may be set before one is recorded in
 * `decision`. `PUBLISHED_PRICING.composedToolPlatformTakeBps` must equal
 * `platformTakeBps`; `standalone-pricing.test.ts` fails until they agree.
 */
export const COMPOSED_TOOL_FEES = {
	decision: {
		decidedOn: null,
		note: "No platform share on composed-tool fees is decided; makers earn the whole fee as spendable credit, and withdrawal is not offered.",
		status: "pending",
	},
	/** The platform's share of each run fee, in basis points (0 to 10,000). */
	platformTakeBps: 0,
} as const satisfies {
	decision: { decidedOn: string | null; note: string; status: string };
	platformTakeBps: number;
};

/**
 * The platform's share of one run fee, rounded down so the maker is never
 * short-changed, and the maker's net.
 */
export function composedToolFeeSplit(
	grossMicroUsd: number,
	platformTakeBps: number = COMPOSED_TOOL_FEES.platformTakeBps
): { netMicroUsd: number; platformTakeMicroUsd: number } {
	if (
		!(
			Number.isSafeInteger(grossMicroUsd) &&
			grossMicroUsd >= 0 &&
			Number.isInteger(platformTakeBps) &&
			platformTakeBps >= 0 &&
			platformTakeBps <= 10_000
		)
	) {
		throw new Error(
			"composed tool fee split needs a whole fee and 0-10,000 bps"
		);
	}
	const platformTakeMicroUsd = Math.floor(
		(grossMicroUsd * platformTakeBps) / 10_000
	);
	return {
		netMicroUsd: grossMicroUsd - platformTakeMicroUsd,
		platformTakeMicroUsd,
	};
}

/**
 * The one rate table for Ryu-hosted standalone services, charged against the
 * organization credit wallet by the control plane's hourly settlement (and, for
 * Mail overage, inline at send). Self-hosted services are never charged.
 *
 * `PUBLISHED_PRICING` in `@ryu/blocks/web/data/standalone-pricing.ts` mirrors
 * these figures for marketing copy, and `standalone-pricing.test.ts` fails
 * until the two agree. Change a rate here and in that mirror in one commit.
 *
 * Connect's row prices only toolkit calls it serves itself (native `rnx_`
 * receipts, ledger reason `connect_native`); its mirror is
 * `CONNECT_NATIVE_CALL_MICRO_USD` in `apps/connect/src/call-money.ts`, which
 * `service-usage-adapters.test.ts` reads. Each Composio execution receipt is
 * priced with the published Composio rates
 * (`crates/gateway/contracts/fixtures/composio-rates.json`), exactly as a call
 * made through Core is. Sites has no Ryu-hosted service and Hire has no
 * runtime, so neither is charged.
 */
export const SERVICE_RATES = {
	box: {
		meters: {
			/** $0.025 per hour of a running `small` Box (2 vCPU, 4 GiB). */
			boxSmallSeconds: {
				freePerMonth: 0,
				microUsd: BOX_SIZE_MICRO_USD_PER_HOUR.small,
				perUnits: 3600,
			},
			/** $0.04 per hour of a running `default` Box (4 vCPU, 8 GiB). */
			boxDefaultSeconds: {
				freePerMonth: 0,
				microUsd: BOX_SIZE_MICRO_USD_PER_HOUR.default,
				perUnits: 3600,
			},
			/** $0.07 per hour of a running `large` Box (8 vCPU, 16 GiB). */
			boxLargeSeconds: {
				freePerMonth: 0,
				microUsd: BOX_SIZE_MICRO_USD_PER_HOUR.large,
				perUnits: 3600,
			},
			/**
			 * Saved Box state (the measured, compressed bytes of each Box's
			 * newest working generation) at $0.05 per GiB-month (30 days, GiB =
			 * 2^30 bytes), above the organization's included Box storage
			 * ({@link boxIncludedStorageGib}). Byte-seconds, one exact line per
			 * Box, so any state size prices exactly before the single round-up.
			 */
			boxStateByteSeconds: {
				freePerMonth: 0,
				microUsd: BOX_STORAGE_MICRO_USD_PER_GIB_MONTH,
				perUnits: 2 ** 30 * SERVICE_BILLING_MONTH_SECONDS,
			},
			/**
			 * Named snapshots at the same $0.05 per GiB-month on their measured
			 * size while the snapshot exists. Snapshots and saved state share the
			 * organization's included Box storage.
			 */
			snapshotByteSeconds: {
				freePerMonth: 0,
				microUsd: BOX_STORAGE_MICRO_USD_PER_GIB_MONTH,
				perUnits: 2 ** 30 * SERVICE_BILLING_MONTH_SECONDS,
			},
		},
	},
	notify: {
		meters: {
			/** $0.10 per 1,000 events accepted, after 10,000 a month. */
			events: { freePerMonth: 10_000, microUsd: 100_000, perUnits: 1000 },
		},
	},
	passport: {
		meters: {
			/**
			 * $0.10 per connection-month (30 days) while a stored connection or MCP
			 * OAuth credential exists, after 5 connection-months a month.
			 */
			connectionSeconds: {
				freePerMonth: 5 * SERVICE_BILLING_MONTH_SECONDS,
				microUsd: 100_000,
				perUnits: SERVICE_BILLING_MONTH_SECONDS,
			},
			/** $0.10 per 1,000 runtime fetches that reach an upstream, after 10,000. */
			fetches: { freePerMonth: 10_000, microUsd: 100_000, perUnits: 1000 },
		},
	},
	connect: {
		meters: {
			/**
			 * $0.40 per 1,000 toolkit calls Connect serves itself (natively routed
			 * toolkits, `source: "native"` usage lines), with no free allowance.
			 * Composio project add-ons never apply to these calls.
			 */
			nativeCalls: { freePerMonth: 0, microUsd: 400, perUnits: 1 },
		},
	},
	mail: {
		meters: {
			/**
			 * $1.00 per 1,000 recipients sent beyond a paid plan's monthly
			 * allowance. The allowance is the plan's `emailMonthlySendLimit`, so no
			 * extra free units apply here; the free baseline never overflows.
			 */
			overageRecipients: {
				freePerMonth: 0,
				microUsd: 1_000_000,
				perUnits: 1000,
			},
		},
	},
} as const satisfies Record<
	string,
	{
		readonly meters: Readonly<Record<string, ServiceMeterRate>>;
	}
>;

/** A quantity of one meter, priced at its rate. */
export interface ServiceChargeLine {
	readonly quantity: number;
	readonly rate: Pick<ServiceMeterRate, "microUsd" | "perUnits">;
}

const greatestCommonDivisor = (a: bigint, b: bigint): bigint => {
	let left = a;
	let right = b;
	while (right !== 0n) {
		[left, right] = [right, left % right];
	}
	return left;
};

/**
 * The exact sum of `quantity * microUsd / perUnits` over every line, rounded UP
 * once to the next whole micro-USD. Summing exactly and rounding once means a
 * window of many small lines is charged what it used, never a micro-USD per
 * line. Quantities are non-negative safe integers (seconds, counts, recipients).
 */
export const serviceChargeMicroUsd = (
	lines: readonly ServiceChargeLine[]
): number => {
	let numerator = 0n;
	let denominator = 1n;
	for (const { quantity, rate } of lines) {
		if (!(Number.isSafeInteger(quantity) && quantity >= 0)) {
			throw new Error("service quantities must be non-negative integers");
		}
		if (
			!(
				Number.isSafeInteger(rate.microUsd) &&
				rate.microUsd >= 0 &&
				Number.isSafeInteger(rate.perUnits) &&
				rate.perUnits > 0
			)
		) {
			throw new Error("service rates must be non-negative integer fractions");
		}
		const per = BigInt(rate.perUnits);
		numerator =
			numerator * per + BigInt(quantity) * BigInt(rate.microUsd) * denominator;
		denominator *= per;
		const divisor = greatestCommonDivisor(numerator, denominator);
		if (divisor > 1n) {
			numerator /= divisor;
			denominator /= divisor;
		}
	}
	const charge = (numerator + denominator - 1n) / denominator;
	if (charge > BigInt(Number.MAX_SAFE_INTEGER)) {
		throw new Error("service charge exceeds the safe billing range");
	}
	return Number(charge);
};

/**
 * The chargeable part of one window's quantity under a monthly free allowance:
 * `max(0, after - free) - max(0, before - free)`, where `before` is the
 * month-to-date quantity already settled and `after` adds this window.
 */
export const chargeableAfterFreeAllowance = (input: {
	freePerMonth: number;
	monthToDateBefore: number;
	quantity: number;
}): number => {
	const after = input.monthToDateBefore + input.quantity;
	return (
		Math.max(0, after - input.freePerMonth) -
		Math.max(0, input.monthToDateBefore - input.freePerMonth)
	);
};
