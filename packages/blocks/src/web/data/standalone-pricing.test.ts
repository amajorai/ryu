import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	BOX_INCLUDED_STORAGE_GIB,
	BOX_MINIMUM_SECONDS_PER_START,
	COMPOSED_TOOL_FEES,
	composedToolFeeSplit,
	DEPOSIT_FEE_BPS,
	DEPOSIT_FEE_BPS_BY_PLAN,
	DEPOSIT_FEE_FIXED_MICRO_USD,
	DEPOSIT_MARGIN_CAP_MICRO_USD,
	EMAIL_QUOTA_FREE,
	emailQuotaForPlan,
	type PlanId,
	planLimit,
	SERVICE_BILLING_MONTH_SECONDS,
	SERVICE_RATES,
	TOOL_SPEND_LADDER,
	toolSpendLadderDisclosure,
} from "@ryu/auth/lib/plans";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
	MaxPlanCard,
	PlusPlanCard,
	PricingPlanGrid,
	ProPlanCard,
	TeamsPlanCard,
} from "../pricing.tsx";
import {
	formatBps,
	formatCount,
	formatUsd,
	formatUsdRate,
	PRICING_COPY,
	PUBLISHED_PRICING,
	type PublishedMailAllowance,
} from "./standalone-pricing.ts";

const repoRoot = new URL("../../../../../", import.meta.url);
const readRepoFile = (path: string): string =>
	readFileSync(new URL(path, repoRoot), "utf8");
const readDoc = (path: string): string =>
	readRepoFile(`apps/fumadocs/content/docs/${path}`);

const BYTES_PER_GIB = 1024 ** 3;
const MICRO_USD_PER_USD = 1_000_000;

const enforcedMail = (plan: PlanId) => {
	const quota = emailQuotaForPlan(plan);
	return {
		plan,
		monthlyEmails: quota.monthlySendLimit,
		storageBytes: quota.storageLimitBytes,
	};
};

const publishedMail = (plan: PlanId, allowance: PublishedMailAllowance) => ({
	plan,
	monthlyEmails: allowance.monthlyEmails,
	storageBytes: allowance.storageGib * BYTES_PER_GIB,
});

test("published deposit fees match the billing catalog", () => {
	const { depositFee } = PUBLISHED_PRICING;
	expect(DEPOSIT_FEE_BPS).toBe(depositFee.baseBps);
	expect(DEPOSIT_FEE_BPS_BY_PLAN["desktop-license"]).toBe(depositFee.baseBps);
	expect(DEPOSIT_FEE_BPS_BY_PLAN["marketplace-membership"]).toBe(
		depositFee.baseBps
	);
	expect(DEPOSIT_FEE_BPS_BY_PLAN.plus).toBe(depositFee.proBps);
	expect(DEPOSIT_FEE_BPS_BY_PLAN.pro).toBe(depositFee.proBps);
	for (const plan of ["max", "teams", "teams-lite", "business"] as const) {
		expect({ plan, bps: DEPOSIT_FEE_BPS_BY_PLAN[plan] }).toEqual({
			plan,
			bps: depositFee.teamBps,
		});
	}
	expect(DEPOSIT_FEE_FIXED_MICRO_USD).toBe(
		depositFee.minimumUsd * MICRO_USD_PER_USD
	);
	expect(DEPOSIT_MARGIN_CAP_MICRO_USD).toBe(
		depositFee.marginCapUsd * MICRO_USD_PER_USD
	);
	expect(PRICING_COPY.depositFeeCap).toBe(
		formatUsd(DEPOSIT_MARGIN_CAP_MICRO_USD / MICRO_USD_PER_USD)
	);
});

test("private offers pay their public counterpart's rate and mail allowance", () => {
	// The public docs no longer list the private offers; they say "private
	// offers use the counterpart rate". These keep that sentence true.
	expect(DEPOSIT_FEE_BPS_BY_PLAN.plus).toBe(DEPOSIT_FEE_BPS_BY_PLAN.pro);
	expect(DEPOSIT_FEE_BPS_BY_PLAN["teams-lite"]).toBe(
		DEPOSIT_FEE_BPS_BY_PLAN.teams
	);
	expect(emailQuotaForPlan("plus")).toEqual(emailQuotaForPlan("pro"));
	expect(emailQuotaForPlan("teams-lite")).toEqual(emailQuotaForPlan("teams"));

	const topUps = readDoc("billing/top-ups.mdx").replaceAll(/\s+/g, " ");
	expect(topUps).toContain(
		"Separately issued private offers use the rate of their public counterpart"
	);
	const inboxes = readDoc("billing/agent-inboxes.mdx").replaceAll(/\s+/g, " ");
	expect(inboxes).toContain("a private individual offer uses");
	expect(inboxes).toContain("a private organization offer uses");
});

test("published Agent Inbox allowances match the enforced quotas", () => {
	const { mail } = PUBLISHED_PRICING;
	expect(EMAIL_QUOTA_FREE.inboxLimit).toBe(mail.free.inboxes);
	expect(EMAIL_QUOTA_FREE.monthlySendLimit).toBe(mail.free.monthlyEmails);
	expect(EMAIL_QUOTA_FREE.storageLimitBytes).toBe(
		mail.free.storageGib * BYTES_PER_GIB
	);
	// Buying a product that adds no hosted mail keeps the free baseline.
	expect(emailQuotaForPlan(null)).toEqual(EMAIL_QUOTA_FREE);
	expect(emailQuotaForPlan("marketplace-membership")).toEqual(EMAIL_QUOTA_FREE);
	expect(emailQuotaForPlan("desktop-license")).toEqual(EMAIL_QUOTA_FREE);
	const paidPlans = [
		["plus", mail.pro],
		["pro", mail.pro],
		["max", mail.max],
		["teams", mail.organization],
		["teams-lite", mail.organization],
		["business", mail.organization],
	] as const;
	expect(paidPlans.map(([plan]) => enforcedMail(plan))).toEqual(
		paidPlans.map(([plan, allowance]) => publishedMail(plan, allowance))
	);
});

test("published Space storage matches the enforced quota", () => {
	const { spaceStorageGb } = PUBLISHED_PRICING;
	expect({
		pro: planLimit("pro", "spaceStorageLimitGb"),
		plus: planLimit("plus", "spaceStorageLimitGb"),
	}).toEqual({
		pro: spaceStorageGb.pro,
		plus: spaceStorageGb.pro,
	});
	const proCard = renderToStaticMarkup(createElement(ProPlanCard));
	const plusCard = renderToStaticMarkup(createElement(PlusPlanCard));
	expect(proCard).toContain(`${spaceStorageGb.pro} GB of space storage`);
	expect(proCard).toContain(
		`${formatCount(PUBLISHED_PRICING.mail.pro.monthlyEmails)} monthly emails, and ${PUBLISHED_PRICING.mail.pro.storageGib} GiB mail storage`
	);
	expect(plusCard).toContain(`${spaceStorageGb.pro} GB of space storage`);
	expect(plusCard).toContain(
		`${formatCount(PUBLISHED_PRICING.mail.pro.monthlyEmails)} monthly emails, and ${PUBLISHED_PRICING.mail.pro.storageGib} GiB mail storage`
	);
});

/** USD for `units` of a hosted-service meter. */
const serviceUsd = (
	rate: { microUsd: number; perUnits: number },
	units: number
): number => (rate.microUsd * units) / rate.perUnits / MICRO_USD_PER_USD;

test("published hosted service rates match SERVICE_RATES", () => {
	const { box, connect, mailOverage, notify, passport } = PUBLISHED_PRICING;
	const boxRates = SERVICE_RATES.box;
	expect(serviceUsd(boxRates.meters.boxSmallSeconds, 3600)).toBe(
		box.smallHourUsd
	);
	expect(serviceUsd(boxRates.meters.boxDefaultSeconds, 3600)).toBe(
		box.defaultHourUsd
	);
	expect(serviceUsd(boxRates.meters.boxLargeSeconds, 3600)).toBe(
		box.largeHourUsd
	);
	expect(BOX_MINIMUM_SECONDS_PER_START).toBe(box.minimumMinutesPerStart * 60);
	expect(SERVICE_BILLING_MONTH_SECONDS).toBe(box.storageMonthDays * 86_400);
	for (const meter of [
		boxRates.meters.boxStateByteSeconds,
		boxRates.meters.snapshotByteSeconds,
	]) {
		expect(serviceUsd(meter, 2 ** 30 * SERVICE_BILLING_MONTH_SECONDS)).toBe(
			box.storageGibMonthUsd
		);
		expect(meter.freePerMonth).toBe(0);
	}
	expect({ ...BOX_INCLUDED_STORAGE_GIB }).toEqual(box.includedStorageGib);
	expect([
		PRICING_COPY.boxSmallHour,
		PRICING_COPY.boxDefaultHour,
		PRICING_COPY.boxLargeHour,
		PRICING_COPY.boxStorageGibMonth,
		PRICING_COPY.boxMinimum,
	]).toEqual(["$0.025", "$0.04", "$0.07", "$0.05", "5-minute minimum"]);
	expect(formatUsdRate(0.1)).toBe("$0.10");
	expect(formatUsdRate(0.0655)).toBe("$0.0655");

	const { events } = SERVICE_RATES.notify.meters;
	expect(serviceUsd(events, 1000)).toBe(notify.eventsPer1000Usd);
	expect(events.freePerMonth).toBe(notify.freeEventsPerMonth);

	const { connectionSeconds, fetches } = SERVICE_RATES.passport.meters;
	expect(serviceUsd(connectionSeconds, SERVICE_BILLING_MONTH_SECONDS)).toBe(
		passport.connectionMonthUsd
	);
	expect(connectionSeconds.freePerMonth).toBe(
		passport.freeConnectionMonths * SERVICE_BILLING_MONTH_SECONDS
	);
	expect(serviceUsd(fetches, 1000)).toBe(passport.fetchesPer1000Usd);
	expect(fetches.freePerMonth).toBe(passport.freeFetchesPerMonth);

	const { overageRecipients } = SERVICE_RATES.mail.meters;
	expect(serviceUsd(overageRecipients, 1000)).toBe(
		mailOverage.recipientsPer1000Usd
	);

	expect(PRICING_COPY.notifyEvents).toBe("$0.10 per 1,000 events");
	expect(PRICING_COPY.passportConnectionMonth).toBe(
		"$0.10 per connection-month"
	);
	expect(PRICING_COPY.passportFetches).toBe("$0.10 per 1,000 fetches");
	expect(PRICING_COPY.mailOverageRecipients).toBe("$1.00 per 1,000 recipients");

	const { nativeCalls } = SERVICE_RATES.connect.meters;
	expect(serviceUsd(nativeCalls, 1000)).toBe(connect.nativeCallsPer1000Usd);
	expect(nativeCalls.freePerMonth).toBe(0);
	expect(PRICING_COPY.connectNativeCalls).toBe("$0.40 per 1,000 calls");
});

test("the published composed-tool platform take is exactly the enforced one", () => {
	expect(COMPOSED_TOOL_FEES.decision.status).toBe("pending");
	expect(PUBLISHED_PRICING.composedToolPlatformTakeBps).toBe(
		COMPOSED_TOOL_FEES.platformTakeBps
	);
	expect(composedToolFeeSplit(2001, 250)).toEqual({
		netMicroUsd: 1951,
		platformTakeMicroUsd: 50,
	});
	expect(composedToolFeeSplit(2000)).toEqual({
		netMicroUsd: 2000,
		platformTakeMicroUsd: 0,
	});
});

test("the published tool spend ladder is exactly the enforced one", () => {
	// Disabled pending a pricing decision, so nothing may be published yet.
	expect(TOOL_SPEND_LADDER.enabled).toBe(false);
	expect(PUBLISHED_PRICING.toolSpendLadder).toEqual(
		toolSpendLadderDisclosure()
	);
});

const escapeRegExp = (value: string): string =>
	value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Reads `fn <name>() -> u64 { <value> }` from the Gateway config. */
function gatewayDefault(config: string, name: string): number {
	const match = config.match(
		new RegExp(`fn ${name}\\(\\) -> u64 \\{\\s*([0-9_]+)\\s*\\}`)
	);
	if (!match?.[1]) {
		throw new Error(`Gateway default ${name} not found in config.rs`);
	}
	return Number(match[1].replaceAll("_", ""));
}

test("published Box rates match the Gateway's default size table and the shared fixture", () => {
	const config = readRepoFile("apps/gateway/src/config.rs");
	const body = config.match(
		/fn default_sandbox_size_rates\(\) -> Option<SizeRates> \{([\s\S]*?)\n\}/
	)?.[1];
	const gateway = Object.fromEntries(
		[...(body ?? "").matchAll(/(small|default|large): ([\d_]+)/g)].map(
			([, size, rate]) => [size, Number((rate ?? "").replaceAll("_", ""))]
		)
	);
	const fixture = JSON.parse(
		readRepoFile("crates/gateway/contracts/fixtures/box-rates.json")
	);
	const { box } = PUBLISHED_PRICING;
	const published = {
		default: Math.round(box.defaultHourUsd * MICRO_USD_PER_USD),
		large: Math.round(box.largeHourUsd * MICRO_USD_PER_USD),
		small: Math.round(box.smallHourUsd * MICRO_USD_PER_USD),
	};
	expect(gateway).toEqual(published);
	expect(fixture.sizeMicroUsdPerHour).toEqual(published);
	expect(fixture.minimumSecondsPerStart).toBe(box.minimumMinutesPerStart * 60);
	expect(fixture.storage.microUsdPerGibMonth).toBe(
		Math.round(box.storageGibMonthUsd * MICRO_USD_PER_USD)
	);
	expect(fixture.storage.includedGibPerOrg).toEqual(box.includedStorageGib);
});

test("published sandbox rates match the Gateway sandbox defaults", () => {
	const config = readRepoFile("apps/gateway/src/config.rs");
	const markup = 1 + gatewayDefault(config, "default_sandbox_markup_bps") / 1e4;
	// Rates are nano-USD per unit-second before the sandbox markup.
	const perHourUsd = (name: string): number =>
		(gatewayDefault(config, name) * 3600 * markup) / 1e9;
	const { sandbox } = PUBLISHED_PRICING;
	expect(formatUsd(perHourUsd("default_sandbox_vcpu_rate"), 4)).toBe(
		formatUsd(sandbox.vcpuHourUsd, 4)
	);
	expect(formatUsd(perHourUsd("default_sandbox_mem_rate"), 4)).toBe(
		formatUsd(sandbox.memoryGibHourUsd, 4)
	);
	expect(formatUsd(perHourUsd("default_sandbox_storage_rate") * 730, 2)).toBe(
		formatUsd(sandbox.storageGibMonthUsd, 2)
	);
	expect(gatewayDefault(config, "default_sandbox_free_storage_gib")).toBe(
		sandbox.freeStorageGib
	);

	// The metering page also lists the Windows and GPU sandbox rates.
	const metering = readDoc("billing/metering.mdx");
	for (const [name, label] of [
		["default_sandbox_windows_vcpu_rate", "Windows surcharge"],
		["default_sandbox_gpu_h200_rate", "H200"],
		["default_sandbox_gpu_h100_rate", "H100"],
		["default_sandbox_gpu_rtx_pro_6000_rate", "RTX PRO 6000"],
		["default_sandbox_gpu_rtx_5090_rate", "RTX 5090"],
		["default_sandbox_gpu_rtx_4090_rate", "RTX 4090"],
	] as const) {
		const decimals = name.includes("gpu") ? 2 : 4;
		const rate = formatUsd(perHourUsd(name), decimals);
		expect(metering).toMatch(
			new RegExp(`\\| ${label} \\| \\*\\*\\+?${escapeRegExp(rate)}\\*\\*`)
		);
	}
});

test("plan cards quote the enforced deposit fees", () => {
	const minimum = formatUsd(DEPOSIT_FEE_FIXED_MICRO_USD / MICRO_USD_PER_USD);
	const cap = formatUsd(DEPOSIT_MARGIN_CAP_MICRO_USD / MICRO_USD_PER_USD);
	const feeLine = (plan: PlanId): string =>
		`${formatBps(DEPOSIT_FEE_BPS_BY_PLAN[plan])} deposit fee (${minimum} minimum, Ryu keeps at most ${cap})`;
	const cards = [
		["pro", renderToStaticMarkup(createElement(ProPlanCard))],
		["plus", renderToStaticMarkup(createElement(PlusPlanCard))],
		["max", renderToStaticMarkup(createElement(MaxPlanCard))],
		["teams", renderToStaticMarkup(createElement(TeamsPlanCard))],
		[
			"business",
			renderToStaticMarkup(
				createElement(PricingPlanGrid, { audience: "business" })
			),
		],
	] as const;
	for (const [plan, html] of cards) {
		expect({ plan, quotesFee: html.includes(feeLine(plan)) }).toEqual({
			plan,
			quotesFee: true,
		});
	}
});
