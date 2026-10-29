"use client";

import { useLiteralMessages } from "@ryu/i18n/react";
import {
	CardContent,
	CardFooter,
	CardHeader,
	CardTitle,
} from "@ryu/ui/components/card";
import { PlanBadge } from "@ryu/ui/components/plan-badge";
import {
	Bot,
	Cloud,
	Coins,
	Download,
	Heart,
	Key,
	Mail,
	Monitor,
	Server,
	Shield,
	Users,
	Zap,
} from "lucide-react";
import {
	formatCount,
	PRICING_COPY,
	PUBLISHED_PRICING,
} from "./data/standalone-pricing.ts";
import { useHelperTextSize } from "./pricing-appearance.tsx";
import {
	DepositFeeFeature,
	IncludedPlanBanner,
	type PlanCardProps,
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
	MAX_INCLUDED_USD,
	MAX_MONTHLY_USD,
	noop,
	PLUS_INCLUDED_USD,
	PLUS_MONTHLY_USD,
	PRO_INCLUDED_USD,
	PRO_MONTHLY_USD,
	SINGAPORE_SERVER_COPY,
} from "./pricing-plan-prices.ts";

/** Pro plan card — the highlighted managed plan (animated gradient border). */
export function ProPlanCard({
	isYearly = false,
	loadingPlan = null,
	onCheckout = noop,
	currentPlan = null,
	productCount,
	soldOut = false,
}: PlanCardProps) {
	const tl = useLiteralMessages();
	const isCurrent = currentPlan === "pro";
	const isLoading =
		loadingPlan === "pro-monthly" || loadingPlan === "pro-yearly";

	return (
		<PricingCardBorder variant="pro">
			<CardHeader>
				<CardTitle layout="badge-row" variant="plan">
					Pro Plan
					<PlanBadge plan="pro" size="md" />
				</CardTitle>
				<PlanDescription>
					Managed AI for one person. Bring a shared workspace to Teams
				</PlanDescription>
			</CardHeader>
			<CardContent className="flex-1">
				<PriceBlock isYearly={isYearly} monthly={PRO_MONTHLY_USD} />
				<PlanFeatureList>
					<li className="flex items-center">
						<Users className="mr-2 size-4" />
						<span>1 personal workspace</span>
					</li>
					<li className="flex items-center">
						<Download className="mr-2 size-4" />
						<span>Full app on all your devices</span>
					</li>
					<li className="flex items-center">
						<Bot className="mr-2 size-4" />
						<span>Personal chats, agents, and spaces</span>
					</li>
					<li className="flex items-center">
						<Cloud className="mr-2 size-4" />
						<span>300+ cloud AI models</span>
					</li>
					<li className="flex items-center">
						<Coins className="mr-2 size-4" />
						<span>
							<span className="font-heading tabular-nums">
								${PRO_INCLUDED_USD}
							</span>
							/month AI usage included
						</span>
					</li>
					<li className="flex items-center">
						<Zap className="mr-2 size-4" />
						<span>Guided setup for your personal workspace</span>
					</li>
					<li className="flex items-center">
						<Monitor className="mr-2 size-4" />
						<span>Run AI on your computer</span>
					</li>
					<li className="flex items-center">
						<Mail className="mr-2 size-4" />
						<span>
							{tl(
								"Agent Inboxes, {monthlyEmails} monthly emails, and {storageGib} GiB mail storage",
								{
									monthlyEmails: formatCount(
										PUBLISHED_PRICING.mail.pro.monthlyEmails
									),
									storageGib: String(PUBLISHED_PRICING.mail.pro.storageGib),
								}
							)}
						</span>
					</li>
					<DepositFeeFeature fee={PRICING_COPY.proDepositFee} />
					<li className="flex items-center">
						<Server className="mr-2 size-4" />
						<span>
							{tl("{storageGb} GB of space storage", {
								storageGb: String(PUBLISHED_PRICING.spaceStorageGb.pro),
							})}
						</span>
					</li>
					{/* A qualifying hosted plan receives one always-on server. The
					    server is the authority for its shape and region. */}
					<li className="flex items-center">
						<Cloud className="mr-2 size-4" />
						<span>{ALWAYS_ON_SERVER_COPY}</span>
					</li>
					<li className="flex items-center">
						<Cloud className="mr-2 size-4" />
						<span>{SINGAPORE_SERVER_COPY}</span>
					</li>
					<li className="flex items-center">
						<Key className="mr-2 size-4" />
						<span>Bring your own API keys</span>
					</li>
					<ProductAccessFeature productCount={productCount} />
				</PlanFeatureList>
			</CardContent>
			<CardFooter>
				<PlanCta
					isCurrent={isCurrent}
					isLoading={isLoading}
					label={currentPlan ? "Upgrade" : "Start with Pro"}
					onClick={() => onCheckout(isYearly ? "pro-yearly" : "pro-monthly")}
					recurring={{ monthly: PRO_MONTHLY_USD, isYearly }}
					soldOut={soldOut}
				/>
			</CardFooter>
		</PricingCardBorder>
	);
}

interface PlusPlanCardProps extends PlanCardProps {
	/**
	 * Whether the card is shown through the private offer link or on the
	 * public shelf (once the page's rollout flag opens it). Copy only.
	 */
	availability?: "private" | "public";
}

/** Plus card — a lower-usage individual companion to Pro, private by default. */
export function PlusPlanCard({
	availability = "private",
	isYearly = false,
	loadingPlan = null,
	onCheckout = noop,
	currentPlan = null,
	productCount,
	soldOut = false,
}: PlusPlanCardProps) {
	const tl = useLiteralMessages();
	const isPrivate = availability === "private";
	const isCurrent = currentPlan === "plus";
	const isLoading =
		loadingPlan === "plus-monthly" || loadingPlan === "plus-yearly";
	const helperText = useHelperTextSize();

	return (
		<PricingCardBorder variant="plus">
			<CardHeader>
				<CardTitle layout="badge-row" variant="plan">
					Plus
					<PlanBadge plan="plus" size="md" />
				</CardTitle>
				<PlanDescription>
					{isPrivate
						? "A private lower-usage Pro companion for one person"
						: "A lower-usage Pro companion for one person"}
				</PlanDescription>
			</CardHeader>
			<CardContent className="flex-1">
				<PriceBlock isYearly={isYearly} monthly={PLUS_MONTHLY_USD} />
				<div className="mb-6">
					<p className="font-medium text-sm">
						{isPrivate ? "Private offer" : "Lower usage"}
					</p>
					<p className={`mt-1 text-muted-foreground ${helperText}`}>
						Lower included usage than Pro, with the same always-on Ryu server.
					</p>
				</div>
				<PlanFeatureList>
					<li className="flex items-center">
						<Users className="mr-2 size-4" />
						<span>1 personal workspace</span>
					</li>
					<li className="flex items-center">
						<Download className="mr-2 size-4" />
						<span>Full app on all your devices</span>
					</li>
					<li className="flex items-center">
						<Bot className="mr-2 size-4" />
						<span>Personal chats, agents, and spaces</span>
					</li>
					<li className="flex items-center">
						<Cloud className="mr-2 size-4" />
						<span>300+ cloud AI models</span>
					</li>
					<li className="flex items-center">
						<Coins className="mr-2 size-4" />
						<span>
							<span className="font-heading tabular-nums">
								${PLUS_INCLUDED_USD}
							</span>
							/month AI usage included
						</span>
					</li>
					<li className="flex items-center">
						<Mail className="mr-2 size-4" />
						<span>
							{tl(
								"Agent Inboxes, {monthlyEmails} monthly emails, and {storageGib} GiB mail storage",
								{
									monthlyEmails: formatCount(
										PUBLISHED_PRICING.mail.pro.monthlyEmails
									),
									storageGib: String(PUBLISHED_PRICING.mail.pro.storageGib),
								}
							)}
						</span>
					</li>
					<DepositFeeFeature fee={PRICING_COPY.proDepositFee} />
					<li className="flex items-center">
						<Server className="mr-2 size-4" />
						<span>
							{tl("{storageGb} GB of space storage", {
								storageGb: String(PUBLISHED_PRICING.spaceStorageGb.pro),
							})}
						</span>
					</li>
					<li className="flex items-center">
						<Cloud className="mr-2 size-4" />
						<span>{ALWAYS_ON_SERVER_COPY}</span>
					</li>
					<li className="flex items-center">
						<Cloud className="mr-2 size-4" />
						<span>{SINGAPORE_SERVER_COPY}</span>
					</li>
					<ProductAccessFeature productCount={productCount} />
				</PlanFeatureList>
			</CardContent>
			<CardFooter>
				<PlanCta
					isCurrent={isCurrent}
					isLoading={isLoading}
					label={currentPlan ? "Upgrade" : "Start with Plus"}
					onClick={() => onCheckout(isYearly ? "plus-yearly" : "plus-monthly")}
					recurring={{ monthly: PLUS_MONTHLY_USD, isYearly }}
					soldOut={soldOut}
				/>
			</CardFooter>
		</PricingCardBorder>
	);
}

/**
 * Max plan card — the individual power tier, with the optional Cloud panel.
 *
 * NO SEAT STEPPER: Max is single-seat now. It was seat-scalable, and that is
 * precisely what made the ladder unreadable — a buyer comparing two multi-seat
 * plans had to do arithmetic to discover the cheaper one was also the better
 * one. Teams owns multi-seat.
 *
 * The bullets lead with what a TOP-UP CANNOT BUY (machine, mail, deposit rate),
 * because the credit line alone no longer justifies the jump and pretending
 * otherwise is how the old $200 tier became unsellable.
 */
/** People in a Max family, owner included; mirrors `FAMILY_SHARING_MAX_MEMBERS`. */
export const MAX_FAMILY_SHARING_MEMBERS = 6;

interface MaxPlanCardProps extends SeatPlanCardProps {
	/**
	 * Show the family-sharing bullet. The page passes the public
	 * `billing.family_sharing` rollout flag; it stays off by default so the
	 * card never advertises sharing that is not rolled out.
	 */
	familySharing?: boolean;
}

export function MaxPlanCard({
	isYearly = false,
	loadingPlan = null,
	onCheckout = noop,
	currentPlan = null,
	cloudTiers = [],
	familySharing = false,
	productCount,
	soldOut = false,
}: MaxPlanCardProps) {
	const tl = useLiteralMessages();
	const isCurrent = currentPlan === "max";
	const isLoading =
		loadingPlan === "max-monthly" || loadingPlan === "max-yearly";
	// `seats` / `minSeats` / `onSeatsChange` are accepted and IGNORED rather than
	// removed from the prop type: the page still passes them, and dropping them
	// from the signature would break the call site for a card that simply has no
	// seat dimension any more. They are inert here on purpose.
	return (
		<PricingCardBorder variant="max">
			<CardHeader>
				<CardTitle layout="badge-row" variant="plan">
					Max Plan
					<PlanBadge plan="max" size="md" />
				</CardTitle>
				<PlanDescription>
					More throughput for one person. Shared agent deployments belong in
					Teams
				</PlanDescription>
			</CardHeader>
			<CardContent className="flex-1">
				<PriceBlock isYearly={isYearly} monthly={MAX_MONTHLY_USD} />
				<IncludedPlanBanner plan="Pro" />
				<PlanFeatureList>
					<li className="flex items-center">
						<Users className="mr-2 size-4" />
						<span>1 personal workspace</span>
					</li>
					{familySharing ? (
						<li className="flex items-center">
							<Heart className="mr-2 size-4" />
							<span>
								{tl("Share with up to {memberCount} family members", {
									memberCount: String(MAX_FAMILY_SHARING_MEMBERS - 1),
								})}
							</span>
						</li>
					) : null}
					<li className="flex items-center">
						<Server className="mr-2 size-4" />
						<span>{ALWAYS_ON_SERVER_COPY}</span>
					</li>
					<li className="flex items-center">
						<Cloud className="mr-2 size-4" />
						<span>{SINGAPORE_SERVER_COPY}</span>
					</li>
					<DepositFeeFeature fee={PRICING_COPY.teamDepositFee} />
					<li className="flex items-center">
						<Bot className="mr-2 size-4" />
						<span>Higher throughput for personal agents and workflows</span>
					</li>
					<li className="flex items-center">
						<Coins className="mr-2 size-4" />
						<span>
							<span className="font-heading tabular-nums">
								${MAX_INCLUDED_USD}
							</span>
							/month AI usage included
						</span>
					</li>
					<li className="flex items-center">
						<Mail className="mr-2 size-4" />
						<span>
							{tl(
								"Agent Inboxes, {monthlyEmails} monthly emails, and {storageGib} GiB mail storage",
								{
									monthlyEmails: formatCount(
										PUBLISHED_PRICING.mail.max.monthlyEmails
									),
									storageGib: String(PUBLISHED_PRICING.mail.max.storageGib),
								}
							)}
						</span>
					</li>
					<li className="flex items-center">
						<Shield className="mr-2 size-4" />
						<span>Priority support</span>
					</li>
					<ProductAccessFeature productCount={productCount} />
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
					label={currentPlan ? "Upgrade" : "Start with Max"}
					onClick={() => onCheckout(isYearly ? "max-yearly" : "max-monthly")}
					recurring={{ monthly: MAX_MONTHLY_USD, isYearly }}
					soldOut={soldOut}
				/>
			</CardFooter>
		</PricingCardBorder>
	);
}
