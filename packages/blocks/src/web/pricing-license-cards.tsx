"use client";

import {
	CardContent,
	CardFooter,
	CardHeader,
	CardTitle,
} from "@ryu/ui/components/card";
import { NumberTicker } from "@ryu/ui/components/number-ticker";
import { PlanBadge } from "@ryu/ui/components/plan-badge";
import {
	Calendar,
	Cloud,
	Download,
	Key,
	Monitor,
	Star,
	Users,
	Wrench,
} from "lucide-react";
import { useHelperTextSize } from "./pricing-appearance.tsx";
import {
	type MarketplacePassPlanCardProps,
	type PlanCardProps,
	PlanCta,
	PlanDescription,
	PlanFeatureList,
	PriceBlock,
	PricingCardBorder,
} from "./pricing-card-parts.tsx";
import { MARKETPLACE_PASS_MONTHLY_USD, noop } from "./pricing-plan-prices.ts";

/** Local desktop license card — shown on the Individual shelf and desktop paywall. */
export function LifetimePlanCard({
	loadingPlan = null,
	onCheckout = noop,
	currentPlan = null,
}: PlanCardProps) {
	const isCurrent = currentPlan === "desktop-license";
	const helperText = useHelperTextSize();
	return (
		<PricingCardBorder variant="desktop-license">
			<CardHeader>
				<CardTitle layout="badge-row" variant="plan">
					Local Desktop
					<PlanBadge label="One-time" plan="desktop-license" size="md" />
				</CardTitle>
				<PlanDescription>
					Ryu runs on your own hardware, and hosted business automation is
					separate
				</PlanDescription>
			</CardHeader>
			<CardContent className="flex-1">
				<div className="mb-1 flex items-baseline gap-2">
					<NumberTicker prefix="$" value={129} variant="featured-plan-price" />
					<span className="font-heading text-muted-foreground text-xl tabular-nums line-through">
						$200
					</span>
					<span className="ml-1 text-muted-foreground">once</span>
				</div>
				<p className={`mb-6 font-medium text-primary ${helperText}`}>
					Launch price with 36% savings
				</p>
				<PlanFeatureList>
					<li className="flex items-center">
						<Monitor className="mr-2 size-4" />
						<span>You can run local agents and workflows on your computer</span>
					</li>
					<li className="flex items-center">
						<Key className="mr-2 size-4" />
						<span>You can use your own keys for cloud AI if you want</span>
					</li>
					<li className="flex items-center">
						<Wrench className="mr-2 size-4" />
						<span>
							Hosted agents, managed servers, and monthly credits are not
							included
						</span>
					</li>
					<li className="flex items-center">
						<Calendar className="mr-2 size-4" />
						<span>One year of updates is included</span>
					</li>
					<li className="flex items-center">
						<Star className="mr-2 size-4" />
						<span>The local trial lasts 7 days and needs no card</span>
					</li>
				</PlanFeatureList>
			</CardContent>
			<CardFooter>
				<PlanCta
					isCurrent={isCurrent}
					isLoading={loadingPlan === "lifetime"}
					label="Get desktop license"
					onClick={() => onCheckout("lifetime")}
					variant="outline"
				/>
			</CardFooter>
		</PricingCardBorder>
	);
}

/** A Major Pass: recurring access to supported paid Marketplace apps. */
export function MarketplacePassPlanCard({
	isYearly = false,
	loadingPlan = null,
	onCheckout = noop,
	currentPlan = null,
}: MarketplacePassPlanCardProps) {
	const isCurrent = currentPlan === "marketplace-membership";
	const monthlyTotal = MARKETPLACE_PASS_MONTHLY_USD;
	const helperText = useHelperTextSize();
	return (
		<PricingCardBorder variant="marketplace-membership">
			<CardHeader>
				<CardTitle layout="badge-row" variant="plan">
					A Major Pass
					<PlanBadge
						label="A Major Pass"
						plan="marketplace-membership"
						size="md"
					/>
				</CardTitle>
				<PlanDescription>
					One pass gives one individual user access to supported paid
					Marketplace apps
				</PlanDescription>
			</CardHeader>
			<CardContent className="flex-1">
				<div className="mb-6">
					<div>
						<PriceBlock
							isYearly={isYearly}
							monthly={monthlyTotal}
							totalMonthly
						/>
						<p className={`-mt-4 text-muted-foreground ${helperText}`}>
							One individual user is included
						</p>
					</div>
				</div>
				<PlanFeatureList>
					<li className="flex items-center">
						<Download className="mr-2 size-4" />
						<span>
							One person can access all supported paid Marketplace apps
						</span>
					</li>
					<li className="flex items-center">
						<Users className="mr-2 size-4" />
						<span>The pass is for one individual user</span>
					</li>
					<li className="flex items-center">
						<Star className="mr-2 size-4" />
						<span>You can see the ticket marker before you install</span>
					</li>
					<li className="flex items-center">
						<Calendar className="mr-2 size-4" />
						<span>
							You can cancel anytime, and access lasts through your paid period
						</span>
					</li>
					<li className="flex items-center text-muted-foreground">
						<Cloud className="mr-2 size-4" />
						<span>
							Managed AI, cloud servers, and monthly credits are not included
						</span>
					</li>
				</PlanFeatureList>
			</CardContent>
			<CardFooter>
				<PlanCta
					isCurrent={isCurrent}
					isLoading={
						loadingPlan ===
						(isYearly
							? "marketplace-membership-yearly"
							: "marketplace-membership-monthly")
					}
					label="Get A Major Pass"
					onClick={() =>
						onCheckout(
							isYearly
								? "marketplace-membership-yearly"
								: "marketplace-membership-monthly"
						)
					}
					recurring={{ monthly: monthlyTotal, isYearly }}
				/>
			</CardFooter>
		</PricingCardBorder>
	);
}
