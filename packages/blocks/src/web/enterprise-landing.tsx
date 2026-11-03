import { HeroBackground } from "./backgrounds/hero-background.tsx";
import { readTheDocsCta } from "./data/resources.tsx";
import { ENTERPRISE_NAV } from "./enterprise-page/enterprise-data.ts";
import { EnterpriseDeployment } from "./enterprise-page/enterprise-deployment.tsx";
import { EnterpriseGlance } from "./enterprise-page/enterprise-glance.tsx";
import { EnterpriseGroupSection } from "./enterprise-page/enterprise-groups.tsx";
import {
	ENTERPRISE_GROUPS,
	type EnterpriseGroupId,
} from "./enterprise-page/enterprise-groups-data.ts";
import { EnterpriseRollout } from "./enterprise-page/enterprise-rollout.tsx";
import { withBentoFigures } from "./iso/figures/bento/with-bento-figures.tsx";
import { landingSectionClass } from "./landing-typography.ts";
import { StageFigure } from "./product-figure.tsx";
import { BAND_CLASSES } from "./product-page/layouts/archetype-theme.ts";
import {
	ProductSectionNav,
	SECTION_ANCHOR_CLASS,
} from "./product-page/sections/section-nav.tsx";
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

/*
 * Composition, top to bottom: the stage hero and figure (unchanged), an
 * "On this page" sub-nav, a tinted at-a-glance sheet, the controls grid, the
 * three themed groups (Governance as ruled rows, Security on an inverse band,
 * Support as tiles with the docs' gating caveat), the deployment comparison,
 * the rollout checklist beside the identity-provider URLs, and the CTA.
 */

function groupById(id: EnterpriseGroupId) {
	const group = ENTERPRISE_GROUPS.find((entry) => entry.id === id);
	if (!group) {
		throw new Error(`Missing enterprise group: ${id}`);
	}
	return group;
}

export default function EnterpriseLanding() {
	return (
		<div data-testid="enterprise-page">
			<ProductHero
				background={<HeroBackground id="page-enterprise" />}
				primaryCta={SALES_CTA}
				secondaryCta={readTheDocsCta(CONTROLS_DOCS_PATH)}
				subtitle="Run agents across your company with single sign-on, permissions, and audit records."
				title="Agents your company controls"
			/>
			<StageFigure figure="passport-cabinet" />
			{/* Sticky sub-nav: a direct child of the page so it can stick past the figure. */}
			<div aria-hidden="true" className="h-16 md:h-24" />
			<ProductSectionNav items={ENTERPRISE_NAV} productName="Enterprise" />

			<div className={BAND_CLASSES.muted} data-enterprise-band="muted">
				<EnterpriseGlance />
			</div>

			<section
				className={`${landingSectionClass} ${SECTION_ANCHOR_CLASS}`}
				data-testid="enterprise-controls"
				id="controls"
			>
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

			<EnterpriseGroupSection group={groupById("governance")} />
			<div className={BAND_CLASSES.inverse} data-enterprise-band="inverse">
				<EnterpriseGroupSection group={groupById("security")} />
			</div>
			<EnterpriseGroupSection group={groupById("support")} layout="cards" />

			<EnterpriseDeployment />
			<EnterpriseRollout />

			<ProductCta
				primaryCta={SALES_CTA}
				secondaryCta={readTheDocsCta(CONTROLS_DOCS_PATH)}
				subtitle=""
				title="Ready to bring agents to your org?"
			/>
		</div>
	);
}
