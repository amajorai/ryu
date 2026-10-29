import { ONBOARDING_TEAMS_OFFER } from "@ryu/auth/lib/onboarding-offer";
import { SubscriptionAgreement } from "@ryu/blocks/web/subscription-agreement.tsx";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Card,
	CardContent,
	CardFooter,
	CardHeader,
	CardTitle,
} from "@ryu/ui/components/card.tsx";
import { ArrowRight, Check, ShieldCheck } from "lucide-react";
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
				<Card
					appearance="onboarding"
					borderTone="subtle"
					className="w-full max-w-xl"
				>
					<CardHeader>
						<div className="flex items-center gap-2">
							<ShieldCheck className="size-5 text-primary" />
							<CardTitle>
								{subscribed
									? "Ready to start"
									: "Run your selected task with Ryu"}
							</CardTitle>
						</div>
						<p className="text-muted-foreground text-sm">
							{subscribed
								? "Your existing subscription covers this workspace."
								: offerDescription}
						</p>
					</CardHeader>
					<CardContent spacing="comfortable">
						{[
							"Ryu lives where you already work",
							"Use the connection needed for your selected task",
							"Work starts only after subscription confirmation",
						].map((item) => (
							<div className="flex items-start gap-2 text-sm" key={item}>
								<Check className="mt-0.5 size-4 shrink-0 text-status-success" />
								<span>{item}</span>
							</div>
						))}
						{error ? (
							<p className="text-sm text-status-destructive" role="alert">
								{error}
							</p>
						) : null}
					</CardContent>
					<CardFooter
						appearance="onboarding-step"
						className="flex-wrap justify-between"
						spacing="choices"
					>
						<Button onClick={onSkip} variant="ghost">
							Choose my own model
						</Button>
						{subscribed ? (
							<Button disabled={pending} loading={pending} onClick={onContinue}>
								Continue to task <ArrowRight className="size-4" />
							</Button>
						) : checkoutOpened || individualCheckoutClosed ? (
							<Button
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
								<ArrowRight className="size-4" />
							</Button>
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
									<Button
										className="w-full"
										disabled={!canContinue}
										loading={pending}
										onClick={onStartCheckout}
									>
										{checkoutLabel}
										<ArrowRight className="size-4" />
									</Button>
								)}
							</SubscriptionAgreement>
						)}
					</CardFooter>
				</Card>
			</ActivationStepShell>
			{dialog}
		</>
	);
}
