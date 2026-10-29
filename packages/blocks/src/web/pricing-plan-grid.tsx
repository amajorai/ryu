"use client";

import {
	AdaptiveStepper,
	AdaptiveStepperDecrement,
	AdaptiveStepperIncrement,
	AdaptiveStepperValue,
} from "@ryu/ui/components/motion/adaptive-stepper.tsx";
import {
	PricingCtaVariantProvider,
	useHelperTextSize,
} from "./pricing-appearance.tsx";
import { MaxPlanCard, ProPlanCard } from "./pricing-individual-cards.tsx";
import { LifetimePlanCard } from "./pricing-license-cards.tsx";
import {
	EnterprisePlanCard,
	HostedAgentPlanCard,
} from "./pricing-organization-cards.tsx";
import {
	type CurrentPricingPlan,
	HOSTED_AGENT_SLIDER_MIN,
	MAX_MIN_SEATS,
	noop,
	type PricingAudience,
	type PricingPlanSlug,
} from "./pricing-plan-prices.ts";
import {
	HOSTED_AGENT_SLIDER_MAX,
	normalizeTeamsSeatCount,
	TEAMS_MAX_SEATS,
	TEAMS_MIN_SEATS,
} from "./pricing-seat-model.ts";

/**
 * Shared organization seat selection for the public Teams/Business shelf.
 *
 * The selected human-seat quantity drives both card totals and the checkout
 * handoff. The final value is an Enterprise handoff, so it keeps the priced
 * cards visible as an anchor while replacing their checkout actions with the
 * sales path.
 */
function OrganizationSeatSelector({
	onChange,
	seats,
}: {
	onChange: (seats: number) => void;
	seats: number;
}) {
	const enterpriseHandoff = seats > TEAMS_MAX_SEATS;
	const seatLabel = (value: number) =>
		value > TEAMS_MAX_SEATS ? `${TEAMS_MAX_SEATS + 1}+` : String(value);
	const helperText = useHelperTextSize();

	return (
		<div
			className="mx-auto mb-8 flex max-w-2xl flex-col gap-4 rounded-2xl border bg-muted/30 p-5 sm:flex-row sm:items-center sm:justify-between"
			data-pricing-seat-selector
		>
			<div>
				<p className="font-medium text-sm">How many people need access?</p>
				<p className={`mt-1 text-muted-foreground ${helperText}`}>
					{enterpriseHandoff
						? "Organizations with more than 50 seats can continue with Enterprise."
						: "Teams and Business share this seat count, from 5 to 50."}
				</p>
			</div>
			{/* The last step past 50 is the Enterprise handoff. */}
			<AdaptiveStepper
				aria-label="Organization seats"
				className="shrink-0"
				formatValueText={(value) => `${seatLabel(value)} seats`}
				max={HOSTED_AGENT_SLIDER_MAX}
				min={TEAMS_MIN_SEATS}
				onValueChange={(value) => onChange(normalizeTeamsSeatCount(value))}
				step={1}
				value={seats}
			>
				<AdaptiveStepperDecrement aria-label="Remove a seat" />
				<AdaptiveStepperValue
					className="font-heading font-medium text-lg tabular-nums"
					data-pricing-seat-value
				>
					{(value: number) => seatLabel(value)}
				</AdaptiveStepperValue>
				<AdaptiveStepperIncrement aria-label="Add a seat" />
			</AdaptiveStepper>
		</div>
	);
}

/**
 * The pricing plans, presentational: the self-serve plans for one AUDIENCE in a
 * grid. The public page uses the business shelf — Teams, Business, and
 * Enterprise. The individual shelf shows the local desktop license, Pro, and
 * Max, with A Major Pass below them. Cloud
 * hosting is NOT here — it lives in the org dashboard (post-auth).
 *
 * The individual shelf is three columns and the organization shelf is three
 * columns. Column count tracks the card count so the local license, two
 * individual managed plans, or the Teams/Business/Enterprise shelf never
 * renders at an accidental quarter-width.
 */
export function PricingPlanGrid({
	audience = "business",
	hostedAgentCount = HOSTED_AGENT_SLIDER_MIN,
	isYearly = false,
	loadingPlan = null,
	onCheckout = noop,
	currentPlan = null,
	maxFamilySharing = false,
	maxSeats,
	onMaxSeatsChange,
	maxMinSeats = MAX_MIN_SEATS,
	onHostedAgentCountChange,
	onSeatsChange,
	seats,
	productCount,
	soldOutPlans,
}: {
	/** Which shelf to render — see {@link PRICING_AUDIENCE_PLANS}. */
	audience?: PricingAudience;
	/** Shared contracted automation-agent count for the hosted shelf. */
	hostedAgentCount?: number;
	isYearly?: boolean;
	loadingPlan?: PricingPlanSlug | null;
	/**
	 * Show Max's family-sharing bullet; pass the public `billing.family_sharing`
	 * rollout flag. Off by default.
	 */
	maxFamilySharing?: boolean;
	/** Seat minimum for Max, from `PLANS.max.seatModel`. */
	maxMinSeats?: number;
	/**
	 * Max's seat count, tracked SEPARATELY from `seats`. Max scales from one seat
	 * and is advertised at a flat monthly price, so seeding it from the Teams
	 * minimum would open the page showing the flagship plan at two seats.
	 */
	maxSeats?: number;
	onCheckout?: (slug: PricingPlanSlug) => void;
	onHostedAgentCountChange?: (agentCount: number) => void;
	/** Supply to turn on Max's seat stepper. */
	onMaxSeatsChange?: (seats: number) => void;
	/** Supply to turn on the Teams seat stepper. */
	onSeatsChange?: (seats: number) => void;
	currentPlan?: CurrentPricingPlan | null;
	/** The Teams seat count; ignored when `onSeatsChange` is absent. */
	seats?: number;
	/** Seat minimum for Teams, from `PLANS.teams.seatModel`. */
	teamsMinSeats?: number;
	/** Number of published products the managed plan includes. */
	productCount?: number;
	/**
	 * Plans whose included cloud computer is out of stock, keyed by plan id
	 * (`pro`, `max`, `teams`, `business`, …). Their cards show "Sold out".
	 */
	soldOutPlans?: Partial<Record<string, boolean>>;
}) {
	if (audience === "individual") {
		return (
			<PricingCtaVariantProvider value="mono">
				<div className="mx-auto mb-12 grid max-w-7xl grid-cols-1 gap-8 md:grid-cols-3">
					<ProPlanCard
						currentPlan={currentPlan}
						isYearly={isYearly}
						loadingPlan={loadingPlan}
						onCheckout={onCheckout}
						productCount={productCount}
						soldOut={soldOutPlans?.pro === true}
					/>
					<MaxPlanCard
						currentPlan={currentPlan}
						familySharing={maxFamilySharing}
						isYearly={isYearly}
						loadingPlan={loadingPlan}
						minSeats={maxMinSeats}
						onCheckout={onCheckout}
						onSeatsChange={onMaxSeatsChange}
						productCount={productCount}
						seats={maxSeats ?? maxMinSeats}
						soldOut={soldOutPlans?.max === true}
					/>
					<LifetimePlanCard
						currentPlan={currentPlan}
						loadingPlan={loadingPlan}
						onCheckout={onCheckout}
					/>
				</div>
			</PricingCtaVariantProvider>
		);
	}
	const selectedSeats = normalizeTeamsSeatCount(seats ?? hostedAgentCount);
	const seatChangeHandler = onSeatsChange ?? onHostedAgentCountChange;

	return (
		<PricingCtaVariantProvider value="mono">
			{seatChangeHandler ? (
				<OrganizationSeatSelector
					onChange={seatChangeHandler}
					seats={selectedSeats}
				/>
			) : null}
			<div className="mx-auto mb-12 grid max-w-7xl grid-cols-1 gap-8 md:grid-cols-3">
				<HostedAgentPlanCard
					agentCount={selectedSeats}
					currentPlan={currentPlan}
					isRecommended={false}
					isYearly={isYearly}
					loadingPlan={loadingPlan}
					onCheckout={onCheckout}
					planId="teams"
					productCount={productCount}
					soldOut={soldOutPlans?.teams === true}
				/>
				<HostedAgentPlanCard
					agentCount={selectedSeats}
					currentPlan={currentPlan}
					isRecommended={selectedSeats <= TEAMS_MAX_SEATS}
					isYearly={isYearly}
					loadingPlan={loadingPlan}
					onCheckout={onCheckout}
					planId="business"
					productCount={productCount}
					soldOut={soldOutPlans?.business === true}
				/>
				<EnterprisePlanCard
					isRecommended={selectedSeats > TEAMS_MAX_SEATS}
					productCount={productCount}
				/>
			</div>
		</PricingCtaVariantProvider>
	);
}
