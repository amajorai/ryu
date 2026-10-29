import { expect, mock, test } from "bun:test";
import { planCardConicGradient } from "@ryu/ui/components/plan-badge";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
	EnterprisePlanCard,
	HostedAgentPlanCard,
	MarketplacePassPlanCard,
	MaxPlanCard,
	PlusPlanCard,
	PRO_MONTHLY_USD,
	PricingAudienceToggle,
	PricingBillingToggle,
	PricingDeploymentToggle,
	PricingInstancePicker,
	PricingPlanGrid,
	ProPlanCard,
	SelfHostedPlanGrid,
	TeamsPlanCard,
} from "./pricing.tsx";

// @ryu/blocks does not depend on Next; the host app provides next/link.
mock.module("next/link", () => ({
	default: ({ children, href }: { children: ReactNode; href: string }) => (
		<a href={href}>{children}</a>
	),
}));
/** CPU, memory, or disk figures a public plan card must not promise. */
const SERVER_SPEC = /\d+\s*(?:vCPU|GB RAM|GB SSD|GiB RAM)/i;

const { StandaloneProductPricingCatalog } = await import(
	"./standalone-product-pricing.tsx"
);

test("pricing cloud instances use server terminology", () => {
	const html = renderToStaticMarkup(
		<PricingInstancePicker
			instances={[
				{
					availableInLocation: true,
					cores: 2,
					diskGb: 40,
					includedWithMax: false,
					memoryGb: 4,
					monthlyUsd: 12,
					perfLabel: "Balanced",
					type: "cx23",
				},
			]}
			locations={[]}
		/>
	);

	expect(html).toContain(
		"We host Core, Gateway, and your agents on your server."
	);
	expect(html).toContain("Deploy server");
	expect(html).not.toContain("Deploy node");
	expect(html).not.toContain("managed node");
});

test("Major Pass uses the shared palette and whole-dollar annual pricing", () => {
	const monthly = renderToStaticMarkup(<MarketplacePassPlanCard />);
	const yearly = renderToStaticMarkup(<MarketplacePassPlanCard isYearly />);

	expect(monthly).toContain('title="Ryu A Major Pass"');
	expect(monthly).toContain("A MAJOR PASS");
	expect(monthly).toContain("One individual user is included");
	expect(monthly).toContain(
		"One pass gives one individual user access to supported paid Marketplace apps"
	);
	expect(monthly).not.toContain("and publishers");
	expect(monthly).not.toContain("marketplace-pass-users");
	expect(monthly).toMatch(/\$<span[^>]*>2<\/span><span[^>]*>0<\/span>/);
	expect(monthly).not.toContain("$20.00");
	expect(yearly).toMatch(
		/\$<span[^>]*>2<\/span><span[^>]*>0<\/span><span[^>]*>0<\/span>/
	);
	expect(yearly).not.toContain("$200.00");
	expect(yearly).toContain('aria-label="$17"');
});

test("the public business shelf omits the seat-sizing explainer", () => {
	const html = renderToStaticMarkup(<PricingPlanGrid audience="business" />);

	expect(html).not.toContain("Choose who needs to use the software");
	expect(html).not.toContain("Multiple teams");
	expect(html).not.toContain("pooled credits");
	expect(html).toContain("5 seats included");
	expect(html).not.toContain("Teams Lite");
	expect(html).not.toContain("Ryu Plus");
	expect(html).not.toContain("people can share");
	expect(html).not.toContain("Your organization gets");
	expect(html).toContain("26% deposit fee ($5 minimum, Ryu keeps at most $10)");
	expect(html).not.toContain("This price covers");
	expect(html).not.toContain("border-border/70 border-b");
	expect(html).not.toContain("border-border/70 border-y");
	expect(html).not.toMatch(/\.\s*<\/(?:span|p)>/);
});

test("managed plan cards describe product access without a count", () => {
	const business = renderToStaticMarkup(
		<PricingPlanGrid audience="business" productCount={30} />
	);
	const individual = renderToStaticMarkup(
		<PricingPlanGrid audience="individual" productCount={30} />
	);
	const plus = renderToStaticMarkup(<PlusPlanCard productCount={30} />);

	expect(business.match(/data-product-access-feature/g)).toHaveLength(3);
	expect(individual.match(/data-product-access-feature/g)).toHaveLength(2);
	expect(plus.match(/data-product-access-feature/g)).toHaveLength(1);
	expect(business).toContain(
		"Use every released Ryu product, and early-access products as they open"
	);
	expect(business).not.toContain("30+");
	expect(individual).toContain(
		"Use every released Ryu product, and early-access products as they open"
	);
	expect(individual).not.toContain("30+");
	expect(plus).toContain(
		"Use every released Ryu product, and early-access products as they open"
	);
	expect(plus).not.toContain("30+");
});

test("the public business shelf exposes the shared seat selector when wired", () => {
	const html = renderToStaticMarkup(
		<PricingPlanGrid
			audience="business"
			onSeatsChange={() => undefined}
			seats={10}
		/>
	);

	expect(html).toContain("data-pricing-seat-selector");
	expect(html).toContain("Organization seats. Current value: 10 seats");
	expect(html).toContain('aria-label="Add a seat"');
	expect(html).toContain("10 seats included");
});

test("the private Plus offer keeps its lower usage contract", () => {
	const html = renderToStaticMarkup(<PlusPlanCard isYearly />);

	expect(html).toContain("PLUS");
	expect(html).toContain("Private offer");
	expect(html).toContain("$10");
	expect(html).toContain("$390");
	expect(html).not.toContain("Ryu Pro");
});

test("the public Plus card drops the private-offer framing", () => {
	const html = renderToStaticMarkup(
		<PlusPlanCard availability="public" isYearly />
	);

	expect(html).toContain("PLUS");
	expect(html).not.toContain("Private offer");
	expect(html).not.toContain("A private");
	expect(html).toContain("$10");
	expect(html).toContain("$390");
});

test("pricing defaults to the organization shelf", () => {
	const html = renderToStaticMarkup(<PricingPlanGrid />);

	expect(html).toContain("5 seats included");
	expect(html).not.toContain("Local Desktop");
});

test("the public individual shelf exposes the local desktop offer", () => {
	const html = renderToStaticMarkup(<PricingPlanGrid audience="individual" />);

	expect(html).toContain("Local Desktop");
	expect(html).not.toContain("Ryu Plus");
	expect(html).toMatch(
		/\$<span[^>]*>1<\/span><span[^>]*>2<\/span><span[^>]*>9<\/span>/
	);
	expect(html).toContain("$200");
});

test("the public Pro offer uses the current margin-safe price", () => {
	expect(PRO_MONTHLY_USD).toBe(49);
	const newBuyer = renderToStaticMarkup(
		<PricingPlanGrid audience="individual" />
	);
	const existingBuyer = renderToStaticMarkup(
		<PricingPlanGrid audience="individual" currentPlan="desktop-license" />
	);

	expect(newBuyer).toContain("Start with Pro");
	expect(newBuyer).toContain("Start with Max");
	expect(existingBuyer).toContain(">Upgrade<");
});

test("the hosted cards promise one always-on server without hardware specs", () => {
	const teams = renderToStaticMarkup(
		<HostedAgentPlanCard agentCount={5} planId="teams" />
	);
	const teamsAtFifty = renderToStaticMarkup(
		<HostedAgentPlanCard agentCount={50} planId="teams" />
	);
	const business = renderToStaticMarkup(
		<HostedAgentPlanCard agentCount={5} planId="business" />
	);

	for (const html of [teams, teamsAtFifty, business]) {
		expect(html).toContain("An always-on Ryu server included");
		expect(html).not.toMatch(SERVER_SPEC);
		expect(html).not.toContain("Two managed servers");
	}
	expect(teams).toContain("Centralized team billing and settings");
	expect(teams).toContain("Team marketplace for skills and plugins");
	expect(teams).toContain("Shared usage analytics");
});

test("public plan cards and shelves name no server specs", () => {
	const surfaces = [
		renderToStaticMarkup(<PricingPlanGrid audience="business" />),
		renderToStaticMarkup(<PricingPlanGrid audience="individual" />),
		renderToStaticMarkup(<ProPlanCard />),
		renderToStaticMarkup(<PlusPlanCard />),
		renderToStaticMarkup(<MaxPlanCard />),
		renderToStaticMarkup(<TeamsPlanCard />),
		renderToStaticMarkup(
			<HostedAgentPlanCard agentCount={5} planId="teams-lite" />
		),
	];
	for (const html of surfaces) {
		expect(html).not.toMatch(SERVER_SPEC);
		expect(html).not.toMatch(/\bc(?:px|x)\d{2}\b/i);
		expect(html).not.toContain("Singapore is a paid add-on");
	}
});

test("individual cards say Singapore servers come with organization plans only", () => {
	for (const html of [
		renderToStaticMarkup(<ProPlanCard />),
		renderToStaticMarkup(<PlusPlanCard />),
		renderToStaticMarkup(<MaxPlanCard />),
	]) {
		expect(html).toContain("An always-on Ryu server included");
		expect(html).toContain(
			"Singapore servers come with Teams and Business only"
		);
	}
});

test("yearly individual prices show the discounted monthly equivalent and annual charge", () => {
	const monthly = renderToStaticMarkup(
		<PricingPlanGrid audience="individual" />
	);
	const yearly = renderToStaticMarkup(
		<PricingPlanGrid audience="individual" isYearly />
	);

	expect(monthly).toContain('aria-label="$49"');
	expect(monthly).toContain('aria-label="$99"');
	expect(yearly).toContain('aria-label="$41"');
	expect(yearly).toContain('aria-label="$83"');
	expect(yearly).toContain('aria-label="$490"');
	expect(yearly).toContain('aria-label="$990"');
	expect(yearly).not.toMatch(/aria-label="\$[\d,]+\./);
});

test("yearly organization prices scale the discounted quote with the seat count", () => {
	for (const {
		planId,
		seats,
		monthlyPrice,
		yearlyEquivalent,
		annualCharge,
	} of [
		{
			planId: "teams",
			seats: 5,
			monthlyPrice: "$250",
			yearlyEquivalent: "$208",
			annualCharge: "$2,500",
		},
		{
			planId: "teams",
			seats: 6,
			monthlyPrice: "$300",
			yearlyEquivalent: "$250",
			annualCharge: "$3,000",
		},
		{
			planId: "business",
			seats: 5,
			monthlyPrice: "$300",
			yearlyEquivalent: "$250",
			annualCharge: "$3,000",
		},
		{
			planId: "business",
			seats: 6,
			monthlyPrice: "$350",
			yearlyEquivalent: "$292",
			annualCharge: "$3,500",
		},
	] as const) {
		const monthly = renderToStaticMarkup(
			<HostedAgentPlanCard agentCount={seats} planId={planId} />
		);
		const yearly = renderToStaticMarkup(
			<HostedAgentPlanCard agentCount={seats} isYearly planId={planId} />
		);
		expect(monthly).toContain(`aria-label="${monthlyPrice}"`);
		expect(yearly).toContain(`aria-label="${yearlyEquivalent}"`);
		expect(yearly).toContain(`aria-label="${annualCharge}"`);
		expect(yearly).not.toMatch(/aria-label="\$[\d,]+\./);
		expect(yearly).toContain("per year, two months free");
	}
});

test("billing period keeps the switch and selected month/year label in sync", () => {
	const monthly = renderToStaticMarkup(<PricingBillingToggle />);
	const yearly = renderToStaticMarkup(<PricingBillingToggle isYearly />);

	expect(monthly).toContain('aria-label="Yearly billing"');
	expect(monthly).toContain('aria-checked="false"');
	expect(monthly).toMatch(
		/<span class="[^"]*font-medium text-foreground[^"]*">Monthly<\/span>/u
	);
	expect(monthly).toMatch(
		/<span class="[^"]*text-muted-foreground[^"]*">Yearly/u
	);
	expect(yearly).toContain('aria-label="Yearly billing"');
	expect(yearly).toContain('aria-checked="true"');
	expect(yearly).toMatch(
		/<span class="[^"]*text-muted-foreground[^"]*">Monthly<\/span>/u
	);
	expect(yearly).toMatch(
		/<span class="[^"]*font-medium text-foreground[^"]*">Yearly/u
	);
});

test("the deployment switch uses the platform and self-hosted labels", () => {
	const html = renderToStaticMarkup(<PricingDeploymentToggle />);

	expect(html).toContain("Ryu Platform");
	expect(html).toContain("Self-Hosted");
	expect(html).toContain("text-xl");
});

test("the self-hosted audience switch labels its organization shelf Enterprise", () => {
	const html = renderToStaticMarkup(
		<PricingAudienceToggle businessLabel="Enterprise" />
	);

	expect(html).toContain(">Individual<");
	expect(html).toContain(">Enterprise<");
	expect(html).not.toContain("Teams &amp; Enterprise");
});

test("the self-hosted Individual shelf is a free personal tier", () => {
	const html = renderToStaticMarkup(
		<SelfHostedPlanGrid audience="individual" />
	);

	expect(html).toContain(">Free<");
	expect(html).toContain("$0");
	expect(html).toContain(
		"Perfect for hobbyists and personal projects. No setup fees, monthly fees, or hidden fees."
	);
	expect(html).toContain(
		"conic-gradient(from var(--tier-border-angle),#fff1b8,#c8942e,#fff1b8)"
	);
	expect(html).not.toContain("Licensed");
});

test("the no-plan Gateway PAYG card uses the supplied logo gradient", () => {
	const html = renderToStaticMarkup(<StandaloneProductPricingCatalog />);

	expect(html).toContain('data-testid="standalone-pricing-card-gateway"');
	expect(html).toContain(
		"conic-gradient(from var(--tier-border-angle),#1e0b33,#354389,#624c95,#a73455,#f83d34,#f3a316,#1e0b33)"
	);
});

test("the public marketplace and credit fee note names only public plans", () => {
	const html = renderToStaticMarkup(<StandaloneProductPricingCatalog />);

	expect(html).toContain("on Pro and");
	expect(html).toContain("on Max, Teams, and Business");
	expect(html).not.toMatch(/\bPlus\b|Teams Lite/u);
});

test("subscription pricing borders retain their own badge palettes", () => {
	for (const [tier, card] of [
		["plus", <PlusPlanCard key="plus" />],
		["pro", <ProPlanCard key="pro" />],
		["max", <MaxPlanCard key="max" />],
		["teams", <TeamsPlanCard key="teams" />],
		[
			"teams-lite",
			<HostedAgentPlanCard
				agentCount={5}
				key="teams-lite"
				planId="teams-lite"
			/>,
		],
		[
			"business",
			<HostedAgentPlanCard agentCount={5} key="business" planId="business" />,
		],
		["enterprise", <EnterprisePlanCard key="enterprise" />],
	] as const) {
		const html = renderToStaticMarkup(card);
		expect(html).toContain(planCardConicGradient(tier));
		expect(html).not.toContain(planCardConicGradient("gateway-payg"));
	}
});

test("the self-hosted Enterprise shelf retains the open-source and licensed options", () => {
	const html = renderToStaticMarkup(<SelfHostedPlanGrid audience="business" />);

	expect(html).toContain("Open source");
	expect(html).toContain("Licensed");
	expect(html).toContain("Custom");
});

test("Max advertises family sharing only when the rollout flag is passed", () => {
	const bullet = "Share with up to 5 family members";
	expect(renderToStaticMarkup(<MaxPlanCard />)).not.toContain(bullet);
	expect(
		renderToStaticMarkup(<PricingPlanGrid audience="individual" />)
	).not.toContain(bullet);
	expect(renderToStaticMarkup(<MaxPlanCard familySharing />)).toContain(bullet);

	const shelf = renderToStaticMarkup(
		<PricingPlanGrid audience="individual" maxFamilySharing />
	);
	expect(shelf).toContain(bullet);
	// One bullet on Max only: no family card, no family price, no Teams copy.
	expect(shelf.split(bullet)).toHaveLength(2);
	expect(
		renderToStaticMarkup(
			<PricingPlanGrid audience="business" maxFamilySharing />
		)
	).not.toContain(bullet);
});
