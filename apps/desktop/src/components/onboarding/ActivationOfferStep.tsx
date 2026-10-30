import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { ONBOARDING_TEAMS_OFFER } from "@ryu/auth/lib/onboarding-offer";
import {
	OnboardingActions,
	OnboardingCta,
} from "@ryu/blocks/desktop/onboarding-shell.tsx";
import { SubscriptionAgreement } from "@ryu/blocks/web/subscription-agreement.tsx";
import { useLiteralMessages } from "@ryu/i18n/react";
import type { ReactNode } from "react";
import { ActivationStepShell } from "./ActivationStepShell.tsx";

const {
	firstMonthCreditPoolUsd,
	includedSeats,
	listMonthlyPriceUsd,
	trialMonthlyPriceUsd,
} = ONBOARDING_TEAMS_OFFER;

/** Prices and terms spell the seat count; the offer has always been five. */
const includedSeatsWord = includedSeats === 5 ? "five" : String(includedSeats);

const TEAMS_OFFER_TERMS = `US$${trialMonthlyPriceUsd} for the first month, then renews automatically at US$${listMonthlyPriceUsd} every month for ${includedSeatsWord} seats, plus applicable taxes, until canceled. The first month includes a US$${firstMonthCreditPoolUsd} shared credit pool; the offer is limited to one organization per account owner.`;

export function ActivationOfferStep({
	checkoutOpened = false,
	dialog,
	error,
	organizationPlan = false,
	onConfirmCheckout,
	onContinue,
	onSkip,
	onStartCheckout,
	individualPlansEnabled = true,
	pending = false,
	subscribed,
}: {
	checkoutOpened?: boolean;
	dialog?: ReactNode;
	error?: string | null;
	onConfirmCheckout: () => void;
	onContinue: () => void;
	onSkip: () => void;
	onStartCheckout: () => void;
	individualPlansEnabled?: boolean;
	pending?: boolean;
	organizationPlan?: boolean;
	subscribed: boolean;
}) {
	const tl = useLiteralMessages();
	const individualCheckoutClosed = !(
		organizationPlan || individualPlansEnabled
	);
	const offerDescription = organizationPlan
		? tl(
				"The first month is {trialMonthlyPrice} and includes a {firstMonthCreditPool} shared credit pool. From month two onward, the {includedSeatsWord}-seat Teams floor is {listMonthlyPrice}/month. One introductory month per account owner.",
				{
					firstMonthCreditPool: `$${firstMonthCreditPoolUsd}`,
					includedSeatsWord,
					listMonthlyPrice: `$${listMonthlyPriceUsd}`,
					trialMonthlyPrice: `$${trialMonthlyPriceUsd}`,
				}
			)
		: individualCheckoutClosed
			? "Personal Pro checkout is temporarily unavailable. Continue with local setup, or choose an organization plan on the public pricing page."
			: "Ryu Pro is $49/month for one person. Choose Max later from Pricing if you need more capacity.";
	const checkoutLabel = organizationPlan
		? tl("Start first month for {trialMonthlyPrice}", {
				trialMonthlyPrice: `$${trialMonthlyPriceUsd}`,
			})
		: individualCheckoutClosed
			? "Continue with local setup"
			: "Start Pro for $49/month";
	return (
		<>
			<ActivationStepShell
				subtitle="Confirm your subscription before Ryu-managed execution starts. Your task preview has not used any credits."
				title={subscribed ? "Your subscription is ready" : "Start with Ryu"}
			>
				<section className="flex flex-col gap-3">
					<h2 className="font-semibold text-sm">
						{subscribed ? "Ready to start" : "Run your selected task with Ryu"}
					</h2>
					<p className="text-pretty text-muted-foreground text-sm">
						{subscribed
							? "Your existing subscription covers this workspace."
							: offerDescription}
					</p>
					<ul className="flex flex-col gap-1 text-detail text-muted-foreground">
						{[
							"Ryu lives where you already work",
							"Use the connection needed for your selected task",
							"Work starts only after subscription confirmation",
						].map((item) => (
							<li key={item}>{item}</li>
						))}
					</ul>
					{error ? (
						<p className="text-sm text-status-destructive" role="alert">
							{error}
						</p>
					) : null}
				</section>
				<OnboardingActions className="justify-between">
					<OnboardingCta onClick={onSkip} tone="secondary">
						Choose my own model
					</OnboardingCta>
					{subscribed ? (
						<OnboardingCta
							disabled={pending}
							loading={pending}
							onClick={onContinue}
						>
							Continue to task
							<HugeiconsIcon icon={ArrowRight01Icon} size={16} />
						</OnboardingCta>
					) : checkoutOpened || individualCheckoutClosed ? (
						<OnboardingCta
							disabled={pending}
							loading={pending}
							onClick={
								individualCheckoutClosed
									? onSkip
									: checkoutOpened
										? onConfirmCheckout
										: onStartCheckout
							}
						>
							{checkoutOpened ? "I finished checkout" : checkoutLabel}
							<HugeiconsIcon icon={ArrowRight01Icon} size={16} />
						</OnboardingCta>
					) : (
						<SubscriptionAgreement
							blocked={pending}
							offerKey={organizationPlan ? "teams-onboarding" : "pro-monthly"}
							terms={
								organizationPlan
									? TEAMS_OFFER_TERMS
									: "Renews automatically at US$49 every month, plus applicable taxes, until canceled."
							}
						>
							{(canContinue) => (
								<OnboardingCta
									className="w-full"
									disabled={!canContinue}
									loading={pending}
									onClick={onStartCheckout}
								>
									{checkoutLabel}
									<HugeiconsIcon icon={ArrowRight01Icon} size={16} />
								</OnboardingCta>
							)}
						</SubscriptionAgreement>
					)}
				</OnboardingActions>
			</ActivationStepShell>
			{dialog}
		</>
	);
}
