import { formatMessage } from "@ryu/i18n/core";
import type { LiteralMessage } from "@ryu/i18n/react";
import {
	formatBps,
	formatCount,
	formatMailAllowance,
	formatUsd,
	formatUsdRate,
	PUBLISHED_PRICING,
} from "./standalone-pricing-figures.ts";
import { pricingFormat } from "./standalone-pricing-locale.ts";

export {
	formatBps,
	formatCount,
	formatMailAllowance,
	formatUsd,
	formatUsdRate,
	PUBLISHED_PRICING,
	type PublishedMailAllowance,
} from "./standalone-pricing-figures.ts";
export {
	ENGLISH_LIMIT_VALUES,
	type LocalizedLimitValues,
	localizedLimitValues,
} from "./standalone-pricing-limits.ts";
export {
	ENGLISH_PRICING_FORMAT,
	type PricingFormat,
	pricingFormat,
} from "./standalone-pricing-locale.ts";

export interface StandaloneProductPricing {
	details: readonly string[];
	name: string;
	price: string;
	slug: string;
	status: "Available" | "Metered" | "Included" | "Early access";
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

const englishLiteral: LiteralMessage = (source, values) =>
	formatMessage(source, values);

/**
 * Current customer-facing price and access status for standalone products,
 * with every price and detail sentence passed through `tl` as one message.
 * Components pass their `useLiteralMessages()` translator and their locale, so
 * the USD figures read in the page's language ("0,025 $" in German); the
 * English default backs {@link STANDALONE_PRODUCT_PRICING}, which the docs
 * drift tests read.
 */
export function standaloneProductPricing(
	tl: LiteralMessage = englishLiteral,
	locale?: string | null
): readonly StandaloneProductPricing[] {
	const f = pricingFormat(locale);
	return [
		{
			slug: "gateway",
			name: "Ryu Gateway",
			status: "Available",
			price: tl(
				"Self-hosting is free. Managed model use is billed at cost, with no per-token markup."
			),
			details: [
				tl(
					"Bring your own provider key and the provider bills your account directly."
				),
				tl(
					"Ryu-managed Gateway usage draws from an included plan pool or prepaid wallet; Ryu adds no per-token markup. A positive wallet balance works without a managed plan or separate Ryu node, and requests stop when eligible credits run out."
				),
				tl(
					"Manual no-plan top-ups use a {baseDepositFee} deposit fee with a {depositFeeMinimum} minimum. Pro pays {proDepositFee}; Max, Teams, and Business pay {teamDepositFee}. Enterprise rates are contracted. Automatic top-up still requires an active managed plan.",
					{
						baseDepositFee: f.bps(depositFee.baseBps),
						depositFeeMinimum: f.usd(depositFee.minimumUsd),
						proDepositFee: f.bps(depositFee.proBps),
						teamDepositFee: f.bps(depositFee.teamBps),
					}
				),
			],
		},
		{
			slug: "passport",
			name: "Ryu Passport",
			status: "Early access",
			price: tl(
				"Ryu-hosted: {connectionPrice} per connection-month after {freeConnections} connection-months, and {fetchesPrice} per 1,000 fetches after {freeFetches} fetches, each month.",
				{
					connectionPrice: f.usd(passport.connectionMonthUsd, 2),
					freeConnections: f.count(passport.freeConnectionMonths),
					fetchesPrice: f.usd(passport.fetchesPer1000Usd, 2),
					freeFetches: f.count(passport.freeFetchesPerMonth),
				}
			),
			details: [
				tl(
					"A connection-month is 30 days of a stored connection or MCP OAuth credential existing; fetches are runtime calls that reach an upstream."
				),
				tl(
					"Usage is settled hourly against the organization's Ryu credits, spending the included plan pool first. Free allowances are per organization per calendar month."
				),
				tl(
					"The product is available through the early-access path; there is no self-serve hosted checkout today. A self-hosted Passport is never billed by Ryu."
				),
			],
		},
		{
			slug: "connect",
			name: "Ryu Connect",
			status: "Early access",
			price: tl(
				"Ryu-hosted: each Composio execution at the published Composio rates; vendor calls on Ryu's key and composed-tool maker fees are charged as shown on each call."
			),
			details: [
				tl(
					"Calls are settled hourly against the organization's Ryu credits, spending the included plan pool first, except composed-tool maker fees, which draw only on top-up credit. A call Ryu Core already charged is never charged twice."
				),
				tl(
					"Premium Composio tools add their exact reported provider charge. A binding can set a per-minute call limit or a cap on premium charges."
				),
				tl(
					"Toolkits a Connect deployment serves natively are charged {callsPrice} per 1,000 calls, with no Composio add-ons, as their own Connect tool-call ledger line.",
					{ callsPrice: f.usd(connect.nativeCallsPer1000Usd, 2) }
				),
				tl(
					"Vendor calls paid with Ryu's key (the credential ladder's last rung) are charged the endpoint's verified per-call price, shown on the call; your own keys are never charged."
				),
				tl(
					"A composed-tool run whose maker is another organization is charged the maker's fee once the run completes, disclosed before the run and paid from top-up credit only, with no free allowance."
				),
				tl(
					"No Ryu-hosted self-serve checkout is available today. A self-hosted Connect is never billed by Ryu."
				),
			],
		},
		{
			slug: "box",
			name: "Ryu Box",
			status: "Metered",
			price: tl(
				"Ryu capacity, per running hour: small {boxSmallHour}, default {boxDefaultHour}, large {boxLargeHour}, billed per minute with a {minimumMinutes}-minute minimum per start. Saved state and snapshots: {boxStorageGibMonth} per GiB-month above the {includedGib} GiB each paid organization includes.",
				{
					boxSmallHour: f.usdRate(box.smallHourUsd),
					boxDefaultHour: f.usdRate(box.defaultHourUsd),
					boxLargeHour: f.usdRate(box.largeHourUsd),
					minimumMinutes: f.count(box.minimumMinutesPerStart),
					boxStorageGibMonth: f.usd(box.storageGibMonthUsd, 2),
					includedGib: f.count(box.includedStorageGib.paid),
				}
			),
			details: [
				tl(
					"Compute is charged while a Box runs, in whole minutes, and each start (create or resume) is charged for at least {minimumMinutes} minutes. A stopped Box costs nothing for compute.",
					{ minimumMinutes: f.count(box.minimumMinutesPerStart) }
				),
				tl(
					"Storage is the measured size of each Box's saved state and of its snapshots, for as long as they are stored. Paid plans include {includedGib} GiB per organization, and storage above it is {boxStorageGibMonth} per GiB-month. Without a paid plan, or during a plan's free trial, storage is limited to {trialGib} GiB and a stopped Box is kept for 14 days.",
					{
						includedGib: f.count(box.includedStorageGib.paid),
						boxStorageGibMonth: f.usd(box.storageGibMonthUsd, 2),
						trialGib: f.count(box.includedStorageGib.trial),
					}
				),
				tl(
					"Dashboard and Box API usage is settled hourly against the organization's Ryu credits, spending the included plan pool first. Boxes that Ryu Core creates are charged through the Gateway sandbox heartbeat instead, at the same rates."
				),
				tl(
					"Dashboard create and resume need a plan pool or a positive balance. Running Boxes, however they were started, are stopped within minutes when credits run out."
				),
				tl(
					"Sizes: small 2 vCPU / 4 GiB, default 4 vCPU / 8 GiB, large 8 vCPU / 16 GiB. Plans limit how many Boxes run at once. Box runs Linux and has no GPU or Windows option."
				),
				tl(
					"Hosted Box is on for every organization. Without a paid plan, an organization with a positive credit balance runs one Box at a time. Connected-provider mode uses the provider's own subscription as the capacity bill."
				),
			],
		},
		{
			slug: "notify",
			name: "Ryu Notify",
			status: "Early access",
			price: tl(
				"Ryu-hosted: {eventsPrice} per 1,000 events after {freeEvents} events each month.",
				{
					eventsPrice: f.usd(notify.eventsPer1000Usd, 2),
					freeEvents: f.count(notify.freeEventsPerMonth),
				}
			),
			details: [
				tl(
					"An accepted event is one stored by the events or topics API; idempotent replays and refused requests are not counted."
				),
				tl(
					"Usage is settled hourly against the organization's Ryu credits, spending the included plan pool first. The free allowance is per organization per calendar month."
				),
				tl(
					"There is no self-serve hosted checkout today. A self-hosted Notify is never billed by Ryu."
				),
			],
		},
		{
			slug: "mail",
			name: "Ryu Mail",
			status: "Included",
			price: tl(
				"Free baseline: {inboxes} inbox, {emails} emails per month, and {storageGib} GiB of stored mail, once per person; emails are counted per recipient. Larger hosted quotas are included with eligible plans.",
				{
					inboxes: f.count(mail.free.inboxes),
					emails: f.count(mail.free.monthlyEmails),
					storageGib: f.count(mail.free.storageGib),
				}
			),
			details: [
				tl(
					"Pro includes {proEmails} emails and {proGib} GiB; Max includes {maxEmails} emails and {maxGib} GiB; Teams and Business include {orgEmails} emails and {orgGib} GiB. Emails are counted per recipient.",
					{
						proEmails: f.count(mail.pro.monthlyEmails),
						proGib: f.count(mail.pro.storageGib),
						maxEmails: f.count(mail.max.monthlyEmails),
						maxGib: f.count(mail.max.storageGib),
						orgEmails: f.count(mail.organization.monthlyEmails),
						orgGib: f.count(mail.organization.storageGib),
					}
				),
				tl(
					"A Major Pass and the desktop license add no hosted mail of their own, so they keep the free baseline."
				),
				tl(
					"On paid plans, recipients beyond the monthly allowance cost {recipientsPrice} per 1,000 recipients from a positive credit balance; without one, the send is refused. The free baseline never overflows into credits.",
					{ recipientsPrice: f.usd(mailOverage.recipientsPer1000Usd, 2) }
				),
				tl(
					"There is no separate public hosted Mail subscription price. Self-hosted Mail uses the operator's own infrastructure and mail transport."
				),
			],
		},
		{
			slug: "messaging",
			name: "Ryu Messaging",
			status: "Early access",
			price: tl(
				"Ryu-hosted: each SMS, MMS, WhatsApp message, voice message, and 30-day phone number lease at the AWS End User Messaging price, passed through with no markup."
			),
			details: [
				tl(
					"Prices vary by destination country, carrier, number type, and WhatsApp category; Ryu charges what AWS publishes and reports, with no Ryu fee on top. Credit top-ups keep their usual deposit fee."
				),
				tl(
					"Each send or lease first holds the most it can cost on the organization's credits, then is charged the price AWS reports, never more than the hold; the rest is released. A send the available credits cannot cover is refused, so Messaging never takes the balance below zero."
				),
				tl(
					"Phone numbers renew every 30 days. A number whose renewal cannot be paid is suspended for 7 days, then released."
				),
				tl(
					"Early access: Ryu enables Messaging for each organization, and the organization must turn on the Ryu Messaging feature. There is no self-hosted Messaging service."
				),
			],
		},
		{
			slug: "sites",
			name: "Ryu Sites",
			status: "Early access",
			price: tl("Standalone hosted pricing is not published yet."),
			details: [
				tl(
					"A self-hosted standalone process is documented; it uses the operator's own infrastructure, DNS, and TLS."
				),
				tl(
					"There is no Ryu-hosted Sites service or self-serve checkout today. Managed public hosting is not provisioned by this runtime."
				),
			],
		},
		{
			slug: "hire",
			name: "Ryu Hire",
			status: "Early access",
			price: tl(
				"Not yet available. No Hire price, run estimate, or credit settlement is published."
			),
			details: [
				tl(
					"Hire is in early access: there is no self-serve way to start a specialist run today, and nothing is billed for Hire."
				),
				tl(
					"Manual no-plan top-ups enable managed Gateway only; a prepaid balance does not grant Hire access."
				),
			],
		},
	];
}

/** The English rows: the published copy the docs and drift tests check. */
export const STANDALONE_PRODUCT_PRICING: readonly StandaloneProductPricing[] =
	standaloneProductPricing();

const pricingBySlug = new Map(
	STANDALONE_PRODUCT_PRICING.map((entry) => [entry.slug, entry])
);

/**
 * One product's row: English by default, or translated through `tl` (and
 * formatted for `locale`) for display.
 */
export function getStandaloneProductPricing(
	slug: string,
	tl?: LiteralMessage,
	locale?: string | null
): StandaloneProductPricing | undefined {
	if (!tl) {
		return pricingBySlug.get(slug);
	}
	return standaloneProductPricing(tl, locale).find(
		(entry) => entry.slug === slug
	);
}
