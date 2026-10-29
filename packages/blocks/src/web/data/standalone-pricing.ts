export interface StandaloneProductPricing {
	details: readonly string[];
	name: string;
	price: string;
	slug: string;
	status: "Available" | "Metered" | "Included" | "Early access";
}

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

const {
	box,
	depositFee,
	mail,
	mailOverage,
	notify,
	passport,
	sandbox,
	connect,
} = PUBLISHED_PRICING;

/** Copy fragments built from {@link PUBLISHED_PRICING} for every pricing surface. */
export const PRICING_COPY = {
	baseDepositFee: formatBps(depositFee.baseBps),
	proDepositFee: formatBps(depositFee.proBps),
	teamDepositFee: formatBps(depositFee.teamBps),
	depositFeeMinimum: formatUsd(depositFee.minimumUsd),
	depositFeeCap: formatUsd(depositFee.marginCapUsd),
	boxSmallHour: formatUsdRate(box.smallHourUsd),
	boxDefaultHour: formatUsdRate(box.defaultHourUsd),
	boxLargeHour: formatUsdRate(box.largeHourUsd),
	boxMinimum: `${box.minimumMinutesPerStart}-minute minimum`,
	boxStorageGibMonth: formatUsd(box.storageGibMonthUsd, 2),
	boxIncludedStorage: `${box.includedStorageGib.paid} GiB`,
	boxTrialStorage: `${box.includedStorageGib.trial} GiB`,
	sandboxVcpuHour: formatUsd(sandbox.vcpuHourUsd, 4),
	sandboxMemoryGibHour: formatUsd(sandbox.memoryGibHourUsd, 4),
	sandboxStorageGibMonth: formatUsd(sandbox.storageGibMonthUsd, 2),
	notifyEvents: `${formatUsd(notify.eventsPer1000Usd, 2)} per 1,000 events`,
	notifyFreeEvents: `${formatCount(notify.freeEventsPerMonth)} events`,
	passportConnectionMonth: `${formatUsd(passport.connectionMonthUsd, 2)} per connection-month`,
	passportFreeConnections: `${passport.freeConnectionMonths} connection-months`,
	passportFetches: `${formatUsd(passport.fetchesPer1000Usd, 2)} per 1,000 fetches`,
	passportFreeFetches: `${formatCount(passport.freeFetchesPerMonth)} fetches`,
	mailOverageRecipients: `${formatUsd(mailOverage.recipientsPer1000Usd, 2)} per 1,000 recipients`,
	connectNativeCalls: `${formatUsd(connect.nativeCallsPer1000Usd, 2)} per 1,000 calls`,
	freeMailBaseline: `${mail.free.inboxes} inbox, ${formatCount(mail.free.monthlyEmails)} emails per month, and ${mail.free.storageGib} GiB of stored mail`,
	paidMailAllowances: `Pro includes ${formatMailAllowance(mail.pro)}; Max includes ${formatMailAllowance(mail.max)}; Teams and Business include ${formatMailAllowance(mail.organization)}`,
} as const;

const copy = PRICING_COPY;

/** Current customer-facing price and access status for standalone products. */
export const STANDALONE_PRODUCT_PRICING: readonly StandaloneProductPricing[] = [
	{
		slug: "gateway",
		name: "Ryu Gateway",
		status: "Available",
		price:
			"Self-hosting is free. Managed model use is billed at cost, with no per-token markup.",
		details: [
			"Bring your own provider key and the provider bills your account directly.",
			"Ryu-managed Gateway usage draws from an included plan pool or prepaid wallet; Ryu adds no per-token markup. A positive wallet balance works without a managed plan or separate Ryu node, and requests stop when eligible credits run out.",
			`Manual no-plan top-ups use a ${copy.baseDepositFee} deposit fee with a ${copy.depositFeeMinimum} minimum. Pro pays ${copy.proDepositFee}; Max, Teams, and Business pay ${copy.teamDepositFee}. Enterprise rates are contracted. Automatic top-up still requires an active managed plan.`,
		],
	},
	{
		slug: "passport",
		name: "Ryu Passport",
		status: "Early access",
		price: `Ryu-hosted: ${copy.passportConnectionMonth} after ${copy.passportFreeConnections}, and ${copy.passportFetches} after ${copy.passportFreeFetches}, each month.`,
		details: [
			"A connection-month is 30 days of a stored connection or MCP OAuth credential existing; fetches are runtime calls that reach an upstream.",
			"Usage is settled hourly against the organization's Ryu credits, spending the included plan pool first. Free allowances are per organization per calendar month.",
			"The product is available through the early-access path; there is no self-serve hosted checkout today. A self-hosted Passport is never billed by Ryu.",
		],
	},
	{
		slug: "connect",
		name: "Ryu Connect",
		status: "Early access",
		price:
			"Ryu-hosted: each Composio execution at the published Composio rates; vendor calls on Ryu's key and composed-tool maker fees are charged as shown on each call.",
		details: [
			"Calls are settled hourly against the organization's Ryu credits, spending the included plan pool first, except composed-tool maker fees, which draw only on top-up credit. A call Ryu Core already charged is never charged twice.",
			"Premium Composio tools add their exact reported provider charge. A binding can set a per-minute call limit or a cap on premium charges.",
			`Toolkits a Connect deployment serves natively are charged ${copy.connectNativeCalls}, with no Composio add-ons, as their own Connect tool-call ledger line.`,
			"Vendor calls paid with Ryu's key (the credential ladder's last rung) are charged the endpoint's verified per-call price, shown on the call; your own keys are never charged.",
			"A composed-tool run whose maker is another organization is charged the maker's fee once the run completes, disclosed before the run and paid from top-up credit only, with no free allowance.",
			"No Ryu-hosted self-serve checkout is available today. A self-hosted Connect is never billed by Ryu.",
		],
	},
	{
		slug: "box",
		name: "Ryu Box",
		status: "Metered",
		price: `Ryu capacity, per running hour: small ${copy.boxSmallHour}, default ${copy.boxDefaultHour}, large ${copy.boxLargeHour}, billed per minute with a ${copy.boxMinimum} per start. Saved state and snapshots: ${copy.boxStorageGibMonth} per GiB-month above the ${copy.boxIncludedStorage} each paid organization includes.`,
		details: [
			`Compute is charged while a Box runs, in whole minutes, and each start (create or resume) is charged for at least ${box.minimumMinutesPerStart} minutes. A stopped Box costs nothing for compute.`,
			`Storage is the measured size of each Box's saved state and of its snapshots, for as long as they are stored. Paid plans include ${copy.boxIncludedStorage} per organization, and storage above it is ${copy.boxStorageGibMonth} per GiB-month. Without a paid plan, or during a plan's free trial, storage is limited to ${copy.boxTrialStorage} and a stopped Box is kept for 14 days.`,
			"Dashboard and Box API usage is settled hourly against the organization's Ryu credits, spending the included plan pool first. Boxes that Ryu Core creates are charged through the Gateway sandbox heartbeat instead, at the same rates.",
			"Dashboard create and resume need a plan pool or a positive balance. Running Boxes, however they were started, are stopped within minutes when credits run out.",
			"Sizes: small 2 vCPU / 4 GiB, default 4 vCPU / 8 GiB, large 8 vCPU / 16 GiB. Plans limit how many Boxes run at once. Box runs Linux and has no GPU or Windows option.",
			"Hosted Box is on for every organization. Without a paid plan, an organization with a positive credit balance runs one Box at a time. Connected-provider mode uses the provider's own subscription as the capacity bill.",
		],
	},
	{
		slug: "notify",
		name: "Ryu Notify",
		status: "Early access",
		price: `Ryu-hosted: ${copy.notifyEvents} after ${copy.notifyFreeEvents} each month.`,
		details: [
			"An accepted event is one stored by the events or topics API; idempotent replays and refused requests are not counted.",
			"Usage is settled hourly against the organization's Ryu credits, spending the included plan pool first. The free allowance is per organization per calendar month.",
			"There is no self-serve hosted checkout today. A self-hosted Notify is never billed by Ryu.",
		],
	},
	{
		slug: "mail",
		name: "Ryu Mail",
		status: "Included",
		price: `Free baseline: ${copy.freeMailBaseline}, once per person; emails are counted per recipient. Larger hosted quotas are included with eligible plans.`,
		details: [
			`${copy.paidMailAllowances}. Emails are counted per recipient.`,
			"A Major Pass and the desktop license add no hosted mail of their own, so they keep the free baseline.",
			`On paid plans, recipients beyond the monthly allowance cost ${copy.mailOverageRecipients} from a positive credit balance; without one, the send is refused. The free baseline never overflows into credits.`,
			"There is no separate public hosted Mail subscription price. Self-hosted Mail uses the operator's own infrastructure and mail transport.",
		],
	},
	{
		slug: "messaging",
		name: "Ryu Messaging",
		status: "Early access",
		price:
			"Ryu-hosted: each SMS, MMS, WhatsApp message, voice message, and 30-day phone number lease at the AWS End User Messaging price, passed through with no markup.",
		details: [
			"Prices vary by destination country, carrier, number type, and WhatsApp category; Ryu charges what AWS publishes and reports, with no Ryu fee on top. Credit top-ups keep their usual deposit fee.",
			"Each send or lease first holds the most it can cost on the organization's credits, then is charged the price AWS reports, never more than the hold; the rest is released. A send the available credits cannot cover is refused, so Messaging never takes the balance below zero.",
			"Phone numbers renew every 30 days. A number whose renewal cannot be paid is suspended for 7 days, then released.",
			"Early access: Ryu enables Messaging for each organization, and the organization must turn on the Ryu Messaging feature. There is no self-hosted Messaging service.",
		],
	},
	{
		slug: "sites",
		name: "Ryu Sites",
		status: "Early access",
		price: "Standalone hosted pricing is not published yet.",
		details: [
			"A self-hosted standalone process is documented; it uses the operator's own infrastructure, DNS, and TLS.",
			"There is no Ryu-hosted Sites service or self-serve checkout today. Managed public hosting is not provisioned by this runtime.",
		],
	},
	{
		slug: "hire",
		name: "Ryu Hire",
		status: "Early access",
		price:
			"Not yet available. No Hire price, run estimate, or credit settlement is published.",
		details: [
			"Hire is in early access: there is no self-serve way to start a specialist run today, and nothing is billed for Hire.",
			"Manual no-plan top-ups enable managed Gateway only; a prepaid balance does not grant Hire access.",
		],
	},
];

const pricingBySlug = new Map(
	STANDALONE_PRODUCT_PRICING.map((entry) => [entry.slug, entry])
);

export function getStandaloneProductPricing(
	slug: string
): StandaloneProductPricing | undefined {
	return pricingBySlug.get(slug);
}
