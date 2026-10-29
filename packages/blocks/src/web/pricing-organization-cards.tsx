"use client";

import { useLiteralMessages } from "@ryu/i18n/react";
import { buttonVariants } from "@ryu/ui/components/button";
import {
	CardContent,
	CardFooter,
	CardHeader,
	CardTitle,
} from "@ryu/ui/components/card";
import { PlanBadge } from "@ryu/ui/components/plan-badge";
import {
	BarChart3,
	Bot,
	Cloud,
	Coins,
	CreditCard,
	Key,
	Mail,
	Server,
	Shield,
	Store,
	Users,
	Wrench,
} from "lucide-react";
import {
	formatCount,
	PRICING_COPY,
	PUBLISHED_PRICING,
} from "./data/standalone-pricing.ts";
import {
	useHelperTextSize,
	usePlanCtaShape,
	usePricingCtaVariant,
} from "./pricing-appearance.tsx";
import {
	DepositFeeFeature,
	IncludedPlanBanner,
	PlanCta,
	PlanDescription,
	PlanFeatureList,
	PriceBlock,
	PricingCardBorder,
	ProductAccessFeature,
	type SeatPlanCardProps,
} from "./pricing-card-parts.tsx";
import { CloudUpgradePanel } from "./pricing-cloud-upgrade-panel.tsx";
import {
	ALWAYS_ON_SERVER_COPY,
	type CurrentPricingPlan,
	type HostedAgentPricingPlanId,
	hostedAgentIncludedCreditUsd,
	hostedAgentMonthlyPriceUsd,
	noop,
	type PricingPlanSlug,
	TEAMS_INCLUDED_USD,
	TEAMS_MONTHLY_PER_SEAT_USD,
} from "./pricing-plan-prices.ts";
import {
	normalizeTeamsSeatCount,
	TEAMS_MAX_SEATS,
	TEAMS_MIN_SEATS,
} from "./pricing-seat-model.ts";

/**
 * Compatibility Teams plan card with the optional Cloud panel. Public hosted
 * pricing uses `HostedAgentPlanCard`; this card is still rendered by the
 * desktop paywall and must therefore show the same five-seat floor and member
 * seat price.
 */
export function TeamsPlanCard({
	isYearly = false,
	loadingPlan = null,
	onCheckout = noop,
	currentPlan = null,
	cloudTiers = [],
	soldOut = false,
}: SeatPlanCardProps) {
	const tl = useLiteralMessages();
	const isCurrent = currentPlan === "teams";
	const isLoading =
		loadingPlan === "teams-monthly" || loadingPlan === "teams-yearly";
	return (
		<PricingCardBorder variant="teams">
			<CardHeader>
				<CardTitle layout="badge-row" variant="plan">
					Teams
					<PlanBadge plan="teams" size="md" />
				</CardTitle>
				<PlanDescription>
					A shared deployment for agents your team can run and oversee
				</PlanDescription>
			</CardHeader>
			<CardContent className="flex-1">
				<PriceBlock
					isYearly={isYearly}
					monthly={TEAMS_MONTHLY_PER_SEAT_USD}
					perSeat
					seats={TEAMS_MIN_SEATS}
				/>
				<PlanFeatureList>
					<li className="flex items-center">
						<Bot className="mr-2 size-4" />
						<span>5 seats included</span>
					</li>
					<li className="flex items-center">
						<Coins className="mr-2 size-4" />
						<span>${TEAMS_INCLUDED_USD}/month shared AI credits</span>
					</li>
					<li className="flex items-center">
						<Shield className="mr-2 size-4" />
						<span>Access controls, spend controls, and audit history</span>
					</li>
					<li className="flex items-center">
						<CreditCard className="mr-2 size-4" />
						<span>Centralized team billing and settings</span>
					</li>
					<li className="flex items-center">
						<Store className="mr-2 size-4" />
						<span>Team marketplace for skills and plugins</span>
					</li>
					<li className="flex items-center">
						<BarChart3 className="mr-2 size-4" />
						<span>Shared usage analytics</span>
					</li>
					<li className="flex items-center">
						<Wrench className="mr-2 size-4" />
						<span>Guided setup for agent workflows</span>
					</li>
					<li className="flex items-center">
						<Mail className="mr-2 size-4" />
						<span>
							{tl(
								"{monthlyEmails} monthly emails and {storageGib} GiB mail storage",
								{
									monthlyEmails: formatCount(
										PUBLISHED_PRICING.mail.organization.monthlyEmails
									),
									storageGib: String(
										PUBLISHED_PRICING.mail.organization.storageGib
									),
								}
							)}
						</span>
					</li>
					<li className="flex items-center">
						<Server className="mr-2 size-4" />
						<span>{ALWAYS_ON_SERVER_COPY}</span>
					</li>
					<DepositFeeFeature fee={PRICING_COPY.teamDepositFee} />
				</PlanFeatureList>
				<CloudUpgradePanel
					loadingPlan={loadingPlan}
					onCheckout={onCheckout}
					tiers={cloudTiers}
				/>
			</CardContent>
			<CardFooter>
				<PlanCta
					isCurrent={isCurrent}
					isLoading={isLoading}
					label="Upgrade"
					onClick={() =>
						onCheckout(isYearly ? "teams-yearly" : "teams-monthly")
					}
					recurring={{
						monthly: TEAMS_MONTHLY_PER_SEAT_USD * TEAMS_MIN_SEATS,
						isYearly,
					}}
					soldOut={soldOut}
					variant="outline"
				/>
			</CardFooter>
		</PricingCardBorder>
	);
}

const HOSTED_PLAN_NAMES = {
	teams: "Teams",
	"teams-lite": "Teams Lite",
	business: "Business",
} as const satisfies Record<HostedAgentPricingPlanId, string>;

const HOSTED_PLAN_DESCRIPTIONS = {
	teams: "A shared deployment for agents your team can run and oversee",
	"teams-lite": "A private lower-usage shared deployment for a small team",
	business:
		"More capacity for managed agent deployments with your tools and workflows",
} as const satisfies Record<HostedAgentPricingPlanId, string>;

/** Organization plan card (Teams, Teams Lite, Business) priced by seat count. */
export function HostedAgentPlanCard({
	agentCount,
	currentPlan = null,
	isYearly = false,
	isRecommended = false,
	loadingPlan = null,
	onCheckout = noop,
	planId,
	productCount,
	soldOut = false,
}: {
	agentCount: number;
	currentPlan?: CurrentPricingPlan | null;
	isYearly?: boolean;
	isRecommended?: boolean;
	loadingPlan?: PricingPlanSlug | null;
	onCheckout?: (slug: PricingPlanSlug) => void;
	planId: HostedAgentPricingPlanId;
	productCount?: number;
	/** The plan's included cloud computer is out of stock, so it cannot be bought. */
	soldOut?: boolean;
}) {
	const tl = useLiteralMessages();
	const ctaVariant = usePricingCtaVariant();
	const ctaShape = usePlanCtaShape();
	const isBusiness = planId === "business";
	const effectiveAgentCount = normalizeTeamsSeatCount(agentCount);
	const exceedsTeamsSelfServe = effectiveAgentCount > TEAMS_MAX_SEATS;
	// Once the slider crosses the self-serve ceiling, keep the card as a clear
	// maximum anchor rather than showing a price for a quantity it cannot sell.
	// Enterprise owns the selected 51+ quantity and the CTA below.
	const displayAgentCount = exceedsTeamsSelfServe
		? TEAMS_MAX_SEATS
		: effectiveAgentCount;
	const monthlyPrice = hostedAgentMonthlyPriceUsd(planId, displayAgentCount);
	const slug = `${planId}-${isYearly ? "yearly" : "monthly"}` as const;
	const isCurrent = currentPlan === planId;
	const isLoading = loadingPlan === slug;
	const includedCredits = hostedAgentIncludedCreditUsd(
		planId,
		displayAgentCount
	);
	const planName = HOSTED_PLAN_NAMES[planId];

	return (
		<PricingCardBorder
			isRecommended={isRecommended}
			variant={isBusiness ? "business" : "teams"}
		>
			<CardHeader>
				<CardTitle layout="badge-row" variant="plan">
					{planName}
					<PlanBadge label={planName} plan={planId} size="md" />
				</CardTitle>
				<PlanDescription>{HOSTED_PLAN_DESCRIPTIONS[planId]}</PlanDescription>
			</CardHeader>
			<CardContent className="flex-1">
				<PriceBlock
					isYearly={isYearly}
					monthly={monthlyPrice}
					perSeat={false}
					seats={displayAgentCount}
					totalMonthly
				/>
				{isBusiness ? <IncludedPlanBanner plan="Teams" /> : null}
				<PlanFeatureList>
					<li className="flex items-center">
						<Bot className="mr-2 size-4" />
						<span>
							{tl("{seatCount} seats included", {
								seatCount: String(displayAgentCount),
							})}
						</span>
					</li>
					<li className="flex items-center">
						<Coins className="mr-2 size-4" />
						<span>
							<span className="font-heading tabular-nums">
								${includedCredits}
							</span>
							/month shared AI credits
						</span>
					</li>
					<li className="flex items-center">
						<Server className="mr-2 size-4" />
						<span>{ALWAYS_ON_SERVER_COPY}</span>
					</li>
					<li className="flex items-center">
						<Shield className="mr-2 size-4" />
						<span>Access controls, spend controls, and audit history</span>
					</li>
					<li className="flex items-center">
						<CreditCard className="mr-2 size-4" />
						<span>Centralized team billing and settings</span>
					</li>
					<li className="flex items-center">
						<Store className="mr-2 size-4" />
						<span>Team marketplace for skills and plugins</span>
					</li>
					<li className="flex items-center">
						<BarChart3 className="mr-2 size-4" />
						<span>Shared usage analytics</span>
					</li>
					<li className="flex items-center">
						<Wrench className="mr-2 size-4" />
						<span>Guided setup for agent workflows</span>
					</li>
					<DepositFeeFeature fee={PRICING_COPY.teamDepositFee} />
					<ProductAccessFeature productCount={productCount} />
				</PlanFeatureList>
			</CardContent>
			<CardFooter>
				{exceedsTeamsSelfServe ? (
					<a
						className={buttonVariants({
							className: ctaShape.className,
							size: ctaShape.size,
							variant: ctaVariant,
						})}
						href="/contact"
					>
						Talk to Enterprise
					</a>
				) : (
					<PlanCta
						isCurrent={isCurrent}
						isLoading={isLoading}
						label={tl("Start with {planName}", { planName })}
						onClick={() => onCheckout(slug)}
						recurring={{ monthly: monthlyPrice, isYearly }}
						soldOut={soldOut}
					/>
				)}
			</CardFooter>
		</PricingCardBorder>
	);
}

/**
 * Enterprise plan — the conversation-led tier beside Teams.
 *
 * The card is intentionally unpriced: procurement, security, onboarding, and
 * deployment are not honest candidates for a public seat calculator.
 *
 * As a card it also does its OTHER job properly: an unpriced option beside a
 * priced one is the anchor that makes the priced one look definite. "Custom"
 * carries no number to compare against, so it can only raise the reference
 * point.
 *
 * No self-serve checkout — the CTA goes to sales.
 */
export function EnterprisePlanCard({
	isRecommended = false,
	productCount,
}: {
	isRecommended?: boolean;
	productCount?: number;
}) {
	const ctaShape = usePlanCtaShape();
	const helperText = useHelperTextSize();
	return (
		<PricingCardBorder isRecommended={isRecommended} variant="enterprise">
			<CardHeader>
				<CardTitle layout="badge-row" variant="plan">
					Enterprise
					<PlanBadge label="Enterprise" plan="enterprise" size="md" />
				</CardTitle>
				<PlanDescription>
					For organizations that need a governed rollout, custom capacity, or
					deployment terms
				</PlanDescription>
			</CardHeader>
			<CardContent className="flex-1">
				{/* No NumberTicker here on purpose: "Custom" is not a number, and the
				    absence of one is the point of the tier. */}
				<div className="mb-1 font-medium text-4xl">Custom</div>
				<p className={`mb-6 text-muted-foreground ${helperText}`}>
					A tailored annual contract
				</p>
				<IncludedPlanBanner plan="Business" />
				<PlanFeatureList>
					<li className="flex items-center">
						<Key className="mr-2 size-4" />
						<span>SSO and SCIM provisioning</span>
					</li>
					<li className="flex items-center">
						<Shield className="mr-2 size-4" />
						<span>Audit logs, custom SLA, and DPA</span>
					</li>
					<li className="flex items-center">
						<Server className="mr-2 size-4" />
						<span>Dedicated or self-hosted deployment</span>
					</li>
					<li className="flex items-center">
						<Cloud className="mr-2 size-4" />
						<span>Choose your data region</span>
					</li>
					<li className="flex items-center">
						<Users className="mr-2 size-4" />
						<span>Named contact and onboarding</span>
					</li>
					<li className="flex items-center">
						<Wrench className="mr-2 size-4" />
						<span>Invoicing, purchase orders, and custom terms</span>
					</li>
					<ProductAccessFeature productCount={productCount} />
				</PlanFeatureList>
			</CardContent>
			<CardFooter>
				<a
					className={buttonVariants({
						variant: "outline",
						className: ctaShape.className,
						size: ctaShape.size,
					})}
					href="/contact"
				>
					Contact sales
				</a>
			</CardFooter>
		</PricingCardBorder>
	);
}
