import { describe, expect, test } from "bun:test";
import { ONBOARDING_TEAMS_OFFER } from "@ryu/auth/lib/onboarding-offer";
import { formatMessage, type MessageValuesInput } from "@ryu/i18n/core";
import { renderToStaticMarkup } from "react-dom/server";
import { ActivationOfferStep } from "./ActivationOfferStep.tsx";
import { activationOfferTerms } from "./activation-offer-terms.ts";

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

	test("renders the renewal terms as whole messages", () => {
		const html = renderToStaticMarkup(
			<ActivationOfferStep {...baseProps} organizationPlan />
		);
		expect(html).toContain(
			`$${ONBOARDING_TEAMS_OFFER.trialMonthlyPriceUsd} for the first month, then renews automatically at $${ONBOARDING_TEAMS_OFFER.listMonthlyPriceUsd} every month for ${ONBOARDING_TEAMS_OFFER.includedSeats} seats, plus applicable taxes, until canceled.`
		);
		const pro = renderToStaticMarkup(
			<ActivationOfferStep {...baseProps} organizationPlan={false} />
		);
		expect(pro).toContain(
			"Renews automatically at $49 every month, plus applicable taxes, until canceled."
		);
	});
});

describe("activation renewal terms in Japanese", () => {
	const sources: string[] = [];
	const japanese = (source: string, values?: MessageValuesInput) => {
		sources.push(source);
		return formatMessage(source, values, "ja");
	};

	test("format prices and the seat count in the requested locale", () => {
		const teams = activationOfferTerms(japanese, true, "ja");
		const pro = activationOfferTerms(japanese, false, "ja");
		// The prices come from Intl in the requested locale, never a
		// hand-built "US$" prefix.
		expect(teams).toContain(
			new Intl.NumberFormat("ja", {
				currency: "USD",
				maximumFractionDigits: 0,
				style: "currency",
			}).format(ONBOARDING_TEAMS_OFFER.listMonthlyPriceUsd)
		);
		expect(teams).not.toContain("US$");
		expect(pro).not.toContain("US$");
		// Both terms reach the catalog as whole sentences, not as values.
		expect(sources).toHaveLength(2);
		for (const source of sources) {
			expect(source).toContain("plus applicable taxes, until canceled.");
		}
	});
});
