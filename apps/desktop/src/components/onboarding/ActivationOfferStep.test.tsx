import { describe, expect, test } from "bun:test";
import { ONBOARDING_TEAMS_OFFER } from "@ryu/auth/lib/onboarding-offer";
import { renderToStaticMarkup } from "react-dom/server";
import { ActivationOfferStep } from "./ActivationOfferStep.tsx";

const baseProps = {
	dialog: null,
	onConfirmCheckout: () => undefined,
	onContinue: () => undefined,
	onSkip: () => undefined,
	onStartCheckout: () => undefined,
	subscribed: false,
};

describe("activation checkout offer", () => {
	test("uses the one-person Pro offer for a personal workspace", () => {
		const html = renderToStaticMarkup(
			<ActivationOfferStep {...baseProps} organizationPlan={false} />
		);

		expect(html).toContain("Ryu Pro is $49/month for one person.");
		expect(html).toContain("Start Pro for $49/month");
		expect(html).not.toContain("five-seat Teams");
	});

	test("uses the five-seat Teams offer for an organization workspace", () => {
		const html = renderToStaticMarkup(
			<ActivationOfferStep {...baseProps} organizationPlan />
		);

		expect(html).toContain("five-seat Teams floor is $250/month");
		expect(html).toContain("Start first month for $50");
	});

	test("reads the Teams offer figures from the offer constants", () => {
		const html = renderToStaticMarkup(
			<ActivationOfferStep {...baseProps} organizationPlan />
		);

		expect(html).toContain(
			`The first month is $${ONBOARDING_TEAMS_OFFER.trialMonthlyPriceUsd} and includes a $${ONBOARDING_TEAMS_OFFER.firstMonthCreditPoolUsd} shared credit pool.`
		);
		expect(html).toContain(
			`Teams floor is $${ONBOARDING_TEAMS_OFFER.listMonthlyPriceUsd}/month`
		);
		expect(html).toContain(
			`Start first month for $${ONBOARDING_TEAMS_OFFER.trialMonthlyPriceUsd}`
		);
		expect(html).toContain("One introductory month per account owner.");
	});

	test("does not offer a dead personal checkout while the rollout is closed", () => {
		const html = renderToStaticMarkup(
			<ActivationOfferStep
				{...baseProps}
				individualPlansEnabled={false}
				organizationPlan={false}
			/>
		);

		expect(html).toContain("Personal Pro checkout is temporarily unavailable");
		expect(html).toContain("Continue with local setup");
		expect(html).not.toContain("Start Pro for $49/month");
	});
});
