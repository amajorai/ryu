import { describe, expect, test } from "bun:test";
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
});
