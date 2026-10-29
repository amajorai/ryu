import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	DEPOSIT_FEE_BPS,
	DEPOSIT_FEE_BPS_BY_PLAN,
	DEPOSIT_FEE_FIXED_MICRO_USD,
	emailQuotaForPlan,
	type PlanId,
} from "@ryu/auth/lib/plans";
import {
	formatBps,
	formatCount,
	formatUsd,
	getStandaloneProductPricing,
	PRICING_COPY,
	PUBLISHED_PRICING,
	STANDALONE_PRODUCT_PRICING,
} from "./standalone-pricing.ts";

// The public docs must quote the figures the billing catalog enforces. Each
// check reads the page that holds the fact today; when a docs reorganization
// moves a fact, repoint the read here rather than dropping the check.
const repoRoot = new URL("../../../../../", import.meta.url);
const readRepoFile = (path: string): string =>
	readFileSync(new URL(path, repoRoot), "utf8");
const readDoc = (path: string): string =>
	readRepoFile(`apps/fumadocs/content/docs/${path}`);

const BYTES_PER_GIB = 1024 ** 3;
const MICRO_USD_PER_USD = 1_000_000;

const escapeRegExp = (value: string): string =>
	value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("the top-up fee table matches the billing catalog", () => {
	const topUps = readDoc("billing/top-ups.mdx");
	const rows = new Map<string, string>();
	for (const match of topUps.matchAll(
		/^\| ([A-Za-z ,]+) \| \*\*([0-9.]+%)\*\* \| \*\*(\$[0-9]+)\*\* \|$/gm
	)) {
		const [, label, rate, minimum] = match;
		if (label && rate && minimum) {
			rows.set(label, `${rate} ${minimum}`);
		}
	}
	const min = formatUsd(DEPOSIT_FEE_FIXED_MICRO_USD / MICRO_USD_PER_USD);
	expect(Object.fromEntries(rows)).toEqual({
		"No managed plan": `${formatBps(DEPOSIT_FEE_BPS)} ${min}`,
		Pro: `${formatBps(DEPOSIT_FEE_BPS_BY_PLAN.pro)} ${min}`,
		Max: `${formatBps(DEPOSIT_FEE_BPS_BY_PLAN.max)} ${min}`,
		Teams: `${formatBps(DEPOSIT_FEE_BPS_BY_PLAN.teams)} ${min}`,
		Business: `${formatBps(DEPOSIT_FEE_BPS_BY_PLAN.business)} ${min}`,
	});
});

test("the Agent Inboxes limits table matches the enforced quotas", () => {
	const inboxes = readDoc("billing/agent-inboxes.mdx");
	const rows = new Map<string, string>();
	for (const match of inboxes.matchAll(
		/^\| ([A-Za-z ,]+) \| \*\*([0-9A-Za-z]+)\*\* \| \*\*([0-9A-Za-z]+)\*\* \| \*\*([0-9,]+)\*\* \| \*\*([0-9]+ GiB)\*\* \|/gm
	)) {
		const [, label, mailboxCount, aliasCount, emails, storage] = match;
		if (label && mailboxCount && aliasCount && emails && storage) {
			rows.set(label, `${mailboxCount} ${aliasCount} ${emails} ${storage}`);
		}
	}
	const row = (plan: PlanId | null): string => {
		const quota = emailQuotaForPlan(plan);
		const inboxCount = Number.isFinite(quota.inboxLimit)
			? String(quota.inboxLimit)
			: "Unlimited";
		const aliasCount = Number.isFinite(quota.aliasLimit)
			? String(quota.aliasLimit)
			: "Unlimited";
		return `${inboxCount} ${aliasCount} ${formatCount(quota.monthlySendLimit)} ${quota.storageLimitBytes / BYTES_PER_GIB} GiB`;
	};
	expect(Object.fromEntries(rows)).toEqual({
		"Free, A Major Pass, desktop license": row(null),
		Pro: row("pro"),
		Max: row("max"),
		Teams: row("teams"),
		Business: row("business"),
	});
});

test("public pricing pages quote the published figures", () => {
	// The Standalone Services overview links to each service page and to
	// Metering Rates for prices instead of repeating them, so it must not quote
	// a figure that could go stale. The gateway, Box, credits and mail pages
	// below carry the figures it used to repeat.
	const index = readDoc("standalone/index.mdx");
	expect(index).not.toMatch(/\$\d/);
	const { mail } = PUBLISHED_PRICING;
	const boxHours = `**${PRICING_COPY.boxSmallHour}, ${PRICING_COPY.boxDefaultHour} or ${PRICING_COPY.boxLargeHour} per hour**`;

	const boxRows = [
		`| \`small\` (2 vCPU, 4 GiB) | **${PRICING_COPY.boxSmallHour}** per hour |`,
		`| \`default\` (4 vCPU, 8 GiB) | **${PRICING_COPY.boxDefaultHour}** per hour |`,
		`| \`large\` (8 vCPU, 16 GiB) | **${PRICING_COPY.boxLargeHour}** per hour |`,
	];
	const boxPage = readDoc("standalone/box.mdx");
	const metering = readDoc("billing/metering.mdx");
	const credits = readDoc("billing/credits.mdx");
	for (const page of [boxPage, metering]) {
		for (const row of boxRows) {
			expect(page).toContain(row);
		}
		expect(page).toContain(`**${PRICING_COPY.boxMinimum}**`);
		expect(page).toContain(
			`**${PRICING_COPY.boxStorageGibMonth}** per GiB-month`
		);
	}
	// Metering Rates links to Box and Sandbox Billing for the storage allowances.
	const sandboxBilling = readDoc("billing/sandbox-billing.mdx");
	for (const page of [boxPage, sandboxBilling]) {
		expect(page).toContain(
			`**${PRICING_COPY.boxStorageGibMonth}** per GiB-month`
		);
		expect(page).toContain(`**${PRICING_COPY.boxIncludedStorage}**`);
		expect(page).toContain(`**${PRICING_COPY.boxTrialStorage}**`);
	}
	expect(credits).toContain(boxHours);
	expect(metering).toContain(
		`**${PRICING_COPY.sandboxVcpuHour}** per vCPU-hour`
	);
	expect(metering).toContain(
		`**${PRICING_COPY.sandboxMemoryGibHour}** per GiB-hour`
	);
	expect(metering).toContain(
		`**${PRICING_COPY.sandboxStorageGibMonth}** per GiB-month`
	);
	// No page still quotes the retired per-resource Box meter or minimum.
	for (const page of [index, boxPage, credits]) {
		expect(page).not.toContain("/vCPU-hour**");
		expect(page).not.toContain("15-minute minimum");
	}

	const gateway = readDoc("standalone/gateway.mdx");
	expect(gateway).toContain(
		`**${PRICING_COPY.baseDepositFee} deposit fee with a ${PRICING_COPY.depositFeeMinimum} minimum**`
	);

	const mailPage = readDoc("standalone/mail.mdx").replaceAll(/\s+/g, " ");
	expect(mailPage).toContain(
		`**${mail.free.inboxes} mailbox, ${emailQuotaForPlan(null).aliasLimit} agent addresses, ${mail.free.monthlyEmails} emails per month, and ${mail.free.storageGib} GiB of stored mail**`
	);
	// Public docs name only the public plans; private offers stay unnamed.
	expect(mailPage).not.toMatch(/\bPlus\b|Teams Lite/u);
	expect(mailPage).toContain(
		`Pro has ${formatCount(mail.pro.monthlyEmails)} emails and ${mail.pro.storageGib} GiB`
	);
	expect(mailPage).toContain(
		`Max has ${formatCount(mail.max.monthlyEmails)} emails and ${mail.max.storageGib} GiB`
	);
	expect(mailPage).toContain(
		`Teams and Business have ${formatCount(mail.organization.monthlyEmails)} emails and ${mail.organization.storageGib} GiB`
	);
});

test("public pages quote the hosted service rates and settle dashboard Boxes", () => {
	const { mailOverage, notify, passport } = PUBLISHED_PRICING;
	const usd = (amount: number) => formatUsd(amount, 2);
	const metering = readDoc("billing/metering.mdx");
	expect(metering).toContain(
		`**${usd(notify.eventsPer1000Usd)}** per 1,000 events | ${formatCount(notify.freeEventsPerMonth)} events |`
	);
	expect(metering).toContain(
		`**${usd(passport.connectionMonthUsd)}** per connection-month (30 days) | ${passport.freeConnectionMonths} connection-months |`
	);
	expect(metering).toContain(
		`**${usd(passport.fetchesPer1000Usd)}** per 1,000 fetches | ${formatCount(passport.freeFetchesPerMonth)} fetches |`
	);
	expect(metering).toContain(
		`**${usd(mailOverage.recipientsPer1000Usd)}** per 1,000 recipients`
	);
	expect(metering).toContain(
		`**${usd(PUBLISHED_PRICING.connect.nativeCallsPer1000Usd)}** per 1,000 calls, with no Composio add-ons`
	);

	const credits = readDoc("billing/credits.mdx");
	expect(credits).toContain(
		`**${usd(notify.eventsPer1000Usd)}** per 1,000 accepted events | ${formatCount(notify.freeEventsPerMonth)} events |`
	);
	expect(credits).toContain(
		`${passport.freeConnectionMonths} connection-months and ${formatCount(passport.freeFetchesPerMonth)} fetches`
	);
	expect(credits).toContain(
		`**${usd(mailOverage.recipientsPer1000Usd)}** per 1,000 recipients beyond`
	);
	expect(credits).toContain(
		`natively at **${usd(PUBLISHED_PRICING.connect.nativeCallsPer1000Usd)}** per 1,000 calls`
	);

	// Each service page states its own rate; the overview links to them.
	const notifyPage = readDoc("standalone/notify.mdx").replaceAll(/\s+/g, " ");
	expect(notifyPage).toContain(
		`**${PRICING_COPY.notifyEvents.replace("events", "accepted events")}**`
	);
	const passportPage = readDoc("standalone/passport.mdx");
	expect(passportPage).toContain(
		`| ${usd(passport.connectionMonthUsd)} per connection-month (30 days) | ${passport.freeConnectionMonths} connection-months per organization |`
	);
	expect(passportPage).toContain(
		`| ${PRICING_COPY.passportFetches} | ${formatCount(passport.freeFetchesPerMonth)} fetches per organization |`
	);

	const unsettled =
		/not (?:yet )?debited|debited yet|not settled|settled yet|not published yet/i;
	for (const page of [
		"billing/metering.mdx",
		"core/boxes.mdx",
		"standalone/box.mdx",
		"standalone/box-lifecycle.mdx",
		"standalone/index.mdx",
	]) {
		expect({ page, unsettled: unsettled.test(readDoc(page)) }).toEqual({
			page,
			unsettled: false,
		});
	}
	for (const slug of ["box", "notify", "passport", "connect", "messaging"]) {
		const entry = getStandaloneProductPricing(slug);
		const text = [entry?.price ?? "", ...(entry?.details ?? [])].join(" ");
		expect({ slug, unsettled: unsettled.test(text) }).toEqual({
			slug,
			unsettled: false,
		});
	}
});

test("billing plan pages quote the published deposit fees and mail allowances", () => {
	const normalize = (page: string): string =>
		readDoc(page).replaceAll(/\s+/g, " ");
	const {
		baseDepositFee,
		depositFeeMinimum: min,
		proDepositFee,
		teamDepositFee,
	} = PRICING_COPY;
	const { organization } = PUBLISHED_PRICING.mail;

	// The plan table and plan prose live on Plans and Pricing; the billing
	// index is a landing page of cards.
	const plans = readDoc("billing/plans.mdx");
	const planFees = new Map<string, string>();
	for (const match of plans.matchAll(
		/^\| \*\*(Pro|Max|Teams|Business)\*\* \|.*\| \*\*([0-9.]+%)\*\* \|$/gm
	)) {
		const [, plan, fee] = match;
		if (plan && fee) {
			planFees.set(plan, fee);
		}
	}
	expect(Object.fromEntries(planFees)).toEqual({
		Pro: proDepositFee,
		Max: teamDepositFee,
		Teams: teamDepositFee,
		Business: teamDepositFee,
	});
	const plansProse = normalize("billing/plans.mdx");
	expect(plansProse).toContain(
		`${teamDepositFee} deposit fee on additional prepaid credits, with a ${min} minimum`
	);
	expect(plansProse).toContain(
		`deposit fee is **${teamDepositFee}**, with a **${min} minimum**`
	);
	// The organization mail allowance is published in the Agent Inboxes limits
	// table (checked against the enforced quota above) and on the Mail page.
	const mailPage = normalize("standalone/mail.mdx");
	expect(mailPage).toContain(
		`Teams and Business have ${formatCount(organization.monthlyEmails)} emails and ${organization.storageGib} GiB`
	);
	expect(mailPage).toContain("Emails are counted per recipient.");

	// Hosted Agent Deployments points to the Teams and Business rows checked
	// above instead of repeating them, so it must not quote a stale fee or price.
	const hostedAgents = normalize("billing/hosted-agents.mdx");
	expect(hostedAgents).toContain("](/docs/billing/plans#teams)");
	expect(hostedAgents).not.toMatch(/\$\d|\d%/);

	const credits = normalize("billing/credits.mdx");
	expect(credits).toContain(
		`**${proDepositFee} on Pro** and **${teamDepositFee} on Max, Teams, and Business**, with a **${min} minimum**`
	);
	expect(credits).toContain(
		`the base fee is **${baseDepositFee} with the same ${min} minimum**`
	);
	expect(credits).toContain(
		`No-plan purchases use the ${baseDepositFee} base deposit fee with a ${min} minimum`
	);
});

test("hosted mail storage is published in GiB, the unit enforcement uses", () => {
	const sources = [
		readDoc("billing/agent-inboxes.mdx"),
		readDoc("billing/plans.mdx"),
		readDoc("billing/top-ups.mdx"),
		readDoc("standalone/index.mdx"),
		readDoc("standalone/mail.mdx"),
		readRepoFile("apps/web/src/app/pricing/faq-items.ts"),
		readRepoFile("packages/blocks/src/web/pricing.tsx"),
		...STANDALONE_PRODUCT_PRICING.flatMap((entry) => [
			entry.price,
			...entry.details,
		]),
	];
	for (const source of sources) {
		expect(source).not.toMatch(/\d+ GB (of )?(stored mail|mail storage)/);
		expect(source).not.toMatch(/\d+ GB storage/);
		expect(source).not.toMatch(/monthly sends|sends\/month|sends per month/);
	}
});

test("Ryu Messaging passes AWS prices through and invents none", () => {
	const awsPricing = "https://aws.amazon.com/end-user-messaging/pricing/";
	const messaging = getStandaloneProductPricing("messaging");
	expect(messaging).toMatchObject({
		name: "Ryu Messaging",
		status: "Early access",
	});
	const copy = [messaging?.price ?? "", ...(messaging?.details ?? [])].join(
		" "
	);
	expect(copy).toContain("AWS End User Messaging price");
	expect(copy).toContain("no markup");
	expect(copy).toContain("never more than the hold");
	// Per-country rates come from AWS; a figure in Ryu's catalog would be invented.
	expect(copy).not.toMatch(/\$\d/);
	expect(STANDALONE_PRODUCT_PRICING.map((entry) => entry.slug)).toEqual(
		expect.arrayContaining(["mail", "messaging"])
	);
	const order = STANDALONE_PRODUCT_PRICING.map((entry) => entry.slug);
	expect(order.indexOf("messaging")).toBe(order.indexOf("mail") + 1);

	const metering = readDoc("billing/metering.mdx");
	expect(metering).toMatch(
		new RegExp(
			`^\\| Messaging \\| .+ \\| The \\[AWS End User Messaging price\\]\\(${escapeRegExp(awsPricing)}\\), with no markup \\| None \\|$`,
			"m"
		)
	);
	const messagingPage = readDoc("standalone/messaging.mdx");
	expect(messagingPage).toContain("passed through with **no markup**");
	const index = readDoc("standalone/index.mdx");
	expect(index).toContain(
		`at the [AWS End User Messaging price](${awsPricing}) with no markup`
	);
	for (const page of [
		"standalone/index.mdx",
		"standalone/messaging.mdx",
		"billing/credits.mdx",
	]) {
		expect({ page, linksAws: readDoc(page).includes(awsPricing) }).toEqual({
			page,
			linksAws: true,
		});
	}
});

test("Ryu Hire has no published price, estimate, or metering status", () => {
	const hire = getStandaloneProductPricing("hire");
	expect(hire?.status).toBe("Early access");
	const copy = [hire?.price ?? "", ...(hire?.details ?? [])].join(" ");
	expect(copy).toContain("Not yet available");
	expect(copy).not.toMatch(
		/\$\d|credit estimate|pay per run|metering eligibility/i
	);

	for (const page of ["standalone/hire.mdx", "standalone/index.mdx"]) {
		const content = readDoc(page);
		expect(content).toContain("not yet available");
		expect(content).not.toMatch(
			/pay-per-run flow|keep the receipt|credit estimate before approval|Approved context, credit estimate/i
		);
	}
});

test("Ryu Box is on for every organization, with the trial storage limit stated", () => {
	const box = getStandaloneProductPricing("box");
	expect(box?.status).toBe("Metered");
	const copy = [box?.price ?? "", ...(box?.details ?? [])].join(" ");
	expect(copy).not.toMatch(/early access|enabled for each organization/i);
	expect(copy).toContain("25 GiB each paid organization includes");
	expect(copy).toContain("storage is limited to 10 GiB");
	expect(copy).toContain("Hosted Box is on for every organization");
	const index = readFileSync(
		new URL(
			"../../../../../apps/fumadocs/content/docs/standalone/index.mdx",
			import.meta.url
		),
		"utf8"
	);
	const boxRow = index.split("\n").find((line) => line.startsWith("| [Box]"));
	expect(boxRow).toBeDefined();
	expect(boxRow).not.toMatch(/early access/i);
});
