import { HeroBackground } from "./backgrounds/hero-background.tsx";
import { readTheDocsCta } from "./data/resources.tsx";
import { withBentoFigures } from "./iso/figures/bento/with-bento-figures.tsx";
import { landingSectionClass } from "./landing-typography.ts";
import { StageFigure } from "./product-figure.tsx";
import {
	BentoGrid,
	type BentoItem,
	type CtaLink,
	ProductCta,
	ProductHero,
	SectionHeading,
} from "./sections.tsx";

const SALES_CTA: CtaLink = {
	href: "mailto:hello@ryuhq.com?subject=Ryu%20Enterprise%20inquiry",
	label: "Talk to sales",
};

export const ENTERPRISE_CONTROLS: BentoItem[] = [
	{
		title: "Your identity provider",
		description: "Connect OIDC or SAML single sign-on and SCIM provisioning.",
	},
	{
		title: "Scoped agent access",
		description:
			"Give each agent only the tools and knowledge it needs, and set what it may run.",
	},
	{
		title: "Rules on model calls",
		description:
			"Route requests through the Gateway for budgets, managed provider keys, and firewall checks.",
	},
	{
		title: "Audit and accountability",
		description:
			"Export redacted audit records showing who acted and what happened.",
	},
	{
		title: "Self-host Core and the Gateway",
		description:
			"Run both on your own infrastructure; model calls leave only for providers you route to.",
	},
];

const CONTROLS_DOCS_PATH = "/docs/security/enterprise-identity";

export default function EnterpriseLanding() {
	return (
		<div data-testid="enterprise-page">
			<ProductHero
				background={<HeroBackground id="page-enterprise" />}
				eyebrow="Ryu Enterprise"
				primaryCta={SALES_CTA}
				secondaryCta={readTheDocsCta(CONTROLS_DOCS_PATH)}
				subtitle="Run agents across your company with single sign-on, permissions, and audit records."
				title="Agents your company controls"
			/>
			<StageFigure figure="passport-cabinet" />

			<section className={landingSectionClass} id="controls">
				<SectionHeading
					subtitle="Keep access, cost, and accountability visible as teams work with agents."
					title="Controls for company-wide use"
				/>
				<BentoGrid
					items={withBentoFigures("enterprise", ENTERPRISE_CONTROLS)}
				/>
				<p className="mt-12 text-muted-foreground text-sm">
					Single sign-on, SCIM, and audit export turn on with an Enterprise plan
					or a self-hosted Enterprise license.
				</p>
			</section>

			<ProductCta
				primaryCta={SALES_CTA}
				secondaryCta={readTheDocsCta(CONTROLS_DOCS_PATH)}
				subtitle=""
				title="Ready to bring agents to your org?"
			/>
		</div>
	);
}
