"use client";

import { buttonVariants } from "@ryu/ui/components/button";
import {
	CardContent,
	CardFooter,
	CardHeader,
	CardTitle,
} from "@ryu/ui/components/card";
import { PlanBadge } from "@ryu/ui/components/plan-badge";
import {
	Bot,
	Coins,
	Cpu,
	Key,
	Scale,
	Server,
	Shield,
	Users,
	Wrench,
} from "lucide-react";
import { docsHref } from "./data/resources.tsx";
import {
	PricingCtaVariantProvider,
	useHelperTextSize,
	usePlanCtaShape,
	usePricingCtaVariant,
} from "./pricing-appearance.tsx";
import {
	IncludedPlanBanner,
	PlanDescription,
	PlanFeatureList,
	PricingCardBorder,
} from "./pricing-card-parts.tsx";
import type { PricingAudience } from "./pricing-plan-prices.ts";

/**
 * THE LICENCE COPY ON THESE TWO CARDS IS LOAD-BEARING — do not simplify it to
 * "open source" or to a single licence name.
 *
 * Ryu is open-CORE, not uniformly permissive, and the split is exactly what the
 * paid tier sells relief from (`docs/open-core.md` is the source of truth):
 *
 *  - `apps/core` and the SDK/CLI are **Apache-2.0** — permissive, no obligations.
 *  - `apps/gateway` and `crates/gateway/*` are **AGPL-3.0** — and the gateway is
 *    the piece a company actually deploys for routing, firewall, PII/DLP,
 *    budgets and audit. AGPL's network clause means an org that MODIFIES the
 *    gateway and offers it over a network owes those modifications back.
 *  - The desktop, web and identity surfaces are proprietary and are not part of
 *    a self-hosted deployment at all.
 *
 * That AGPL boundary is the commercial-licence lever, and it is a stronger offer
 * than "we'll support you": the paid tier sells an actual alternative licence to
 * an actual obligation. Writing "Apache 2.0 licensed" across the whole product
 * (which is what a competitor with a uniformly-permissive core can truthfully
 * say) would be FALSE here, and a wrong licence claim on a public pricing page is
 * the most expensive error this file can carry.
 *
 * No price is quoted for the licensed tier. There is no per-annum figure to
 * quote — `docs/enterprise-pricing-framework.md` prices contracts case by case.
 */
export function SelfHostedOssCard({
	individual = false,
}: {
	individual?: boolean;
}) {
	const ctaShape = usePlanCtaShape();
	const helperText = useHelperTextSize();
	return (
		<PricingCardBorder variant="desktop-license">
			<CardHeader>
				<CardTitle variant="plan">
					{individual ? "Free" : "Open source"}
				</CardTitle>
				<PlanDescription>
					{individual
						? "Perfect for hobbyists and personal projects. No setup fees, monthly fees, or hidden fees."
						: "Run the whole engine on your own machines"}
				</PlanDescription>
			</CardHeader>
			<CardContent className="flex-1">
				<div className="mb-1 font-heading font-medium text-4xl tabular-nums">
					$0
				</div>
				<p className={`mb-6 text-muted-foreground ${helperText}`}>
					Free forever with community support
				</p>
				<PlanFeatureList>
					<li className="flex items-center">
						<Scale className="mr-2 size-4 shrink-0" />
						<span>The core uses Apache-2.0 and the gateway uses AGPL-3.0</span>
					</li>
					<li className="flex items-center">
						<Bot className="mr-2 size-4 shrink-0" />
						<span>
							Agents, workflows, memory, and tools with no Ryu plan cap
						</span>
					</li>
					<li className="flex items-center">
						<Shield className="mr-2 size-4 shrink-0" />
						<span>Gateway routing, firewall rules, and budgets</span>
					</li>
					<li className="flex items-center">
						<Key className="mr-2 size-4 shrink-0" />
						<span>You use your own provider keys</span>
					</li>
					<li className="flex items-center">
						<Server className="mr-2 size-4 shrink-0" />
						<span>Nothing leaves your network</span>
					</li>
					<li className="flex items-center">
						<Users className="mr-2 size-4 shrink-0" />
						<span>Community support</span>
					</li>
				</PlanFeatureList>
			</CardContent>
			<CardFooter>
				<a
					className={buttonVariants({
						variant: "outline",
						className: ctaShape.className,
						size: ctaShape.size,
					})}
					href={docsHref("/docs/start-here/getting-started/self-host")}
				>
					Read the self-hosting guide
				</a>
			</CardFooter>
		</PricingCardBorder>
	);
}

/** The commercial licence: AGPL relief, plus the controls an enterprise needs. */
export function SelfHostedLicensedCard() {
	const ctaVariant = usePricingCtaVariant();
	const ctaShape = usePlanCtaShape();
	const helperText = useHelperTextSize();
	return (
		<PricingCardBorder variant="enterprise">
			<CardHeader>
				<CardTitle layout="badge-row" variant="plan">
					Licensed
					<PlanBadge label="Enterprise" plan="enterprise" size="md" />
				</CardTitle>
				<PlanDescription>
					A commercial licence, on your infrastructure
				</PlanDescription>
			</CardHeader>
			<CardContent className="flex-1">
				<div className="mb-1 font-medium text-4xl">Custom</div>
				<p className={`mb-6 text-muted-foreground ${helperText}`}>
					You pay a flat annual fee with no per-seat or per-token metering
				</p>
				<IncludedPlanBanner plan="open source" />
				<PlanFeatureList>
					<li className="flex items-center">
						<Scale className="mr-2 size-4 shrink-0" />
						<span>Commercial licence with no AGPL obligations</span>
					</li>
					<li className="flex items-center">
						<Key className="mr-2 size-4 shrink-0" />
						<span>SSO and SCIM provisioning</span>
					</li>
					<li className="flex items-center">
						<Shield className="mr-2 size-4 shrink-0" />
						<span>Audit logs, custom SLA, and DPA</span>
					</li>
					<li className="flex items-center">
						<Cpu className="mr-2 size-4 shrink-0" />
						<span>Air-gapped and offline deployment</span>
					</li>
					<li className="flex items-center">
						<Wrench className="mr-2 size-4 shrink-0" />
						<span>Named support engineer and onboarding</span>
					</li>
					<li className="flex items-center">
						<Coins className="mr-2 size-4 shrink-0" />
						<span>Invoicing, purchase orders, and custom terms</span>
					</li>
				</PlanFeatureList>
			</CardContent>
			<CardFooter>
				<a
					className={buttonVariants({
						className: ctaShape.className,
						size: ctaShape.size,
						variant: ctaVariant,
					})}
					href="/contact"
				>
					Talk to us
				</a>
			</CardFooter>
		</PricingCardBorder>
	);
}

/**
 * The self-hosted shelf: the Individual view shows the free tier, while the
 * Enterprise view keeps the open-source and commercial-license options.
 *
 * Two columns for two cards, matching the platform shelf's rule that column
 * count tracks card count — a wider grid holding two cards reads as a page that
 * failed to load.
 */
export function SelfHostedPlanGrid({
	audience = "business",
}: {
	audience?: PricingAudience;
}) {
	if (audience === "individual") {
		return (
			<div className="mx-auto mb-12 grid max-w-xl grid-cols-1 gap-8">
				<SelfHostedOssCard individual />
			</div>
		);
	}

	return (
		<PricingCtaVariantProvider value="mono">
			<div className="mx-auto mb-12 grid max-w-4xl grid-cols-1 gap-8 md:grid-cols-2">
				<SelfHostedOssCard />
				<SelfHostedLicensedCard />
			</div>
		</PricingCtaVariantProvider>
	);
}
