import { describe, expect, test } from "bun:test";
import { ONBOARDING_TEAMS_OFFER } from "@ryu/auth/lib/onboarding-offer";
import { PLAN_MONTHLY_PRICE_MICRO_USD } from "@ryu/auth/lib/plans";
import { formatMessage, type MessageValuesInput } from "@ryu/i18n/core";
import { activationOfferCopy } from "./activation-offer-copy.ts";

const english = (source: string, values?: MessageValuesInput) =>
	formatMessage(source, values ?? {}, "en");

function usd(locale: string, amount: number): string {
	return new Intl.NumberFormat(locale, {
		currency: "USD",
		maximumFractionDigits: 0,
		minimumFractionDigits: 0,
		style: "currency",
	}).format(amount);
}

const PRO_USD = PLAN_MONTHLY_PRICE_MICRO_USD.pro / 1_000_000;

describe("activation offer price tile", () => {
	test("English reads the Teams offer from the offer constants", () => {
		const copy = activationOfferCopy(english, true, "en");
		expect(copy.amount).toBe(`$${ONBOARDING_TEAMS_OFFER.trialMonthlyPriceUsd}`);
		expect(copy.cadence).toBe("first month");
		expect(copy.recurring).toBe(
			`$${ONBOARDING_TEAMS_OFFER.listMonthlyPriceUsd}/month from month two`
		);
	});

	test("English reads the Pro price from the plan price table", () => {
		const copy = activationOfferCopy(english, false, "en");
		expect(copy.amount).toBe(`$${PRO_USD}`);
		expect(copy.cadence).toBe("per month for one person");
		expect(copy.recurring).toBe("Choose Max later if you need more capacity");
	});

	test("German formats the amounts as German USD", () => {
		const teams = activationOfferCopy(english, true, "de");
		const trial = usd("de", ONBOARDING_TEAMS_OFFER.trialMonthlyPriceUsd);
		expect(teams.amount).toBe(trial);
		expect(teams.amount).not.toStartWith("$");
		expect(teams.recurring).toContain(
			usd("de", ONBOARDING_TEAMS_OFFER.listMonthlyPriceUsd)
		);
		expect(activationOfferCopy(english, false, "de").amount).toBe(
			usd("de", PRO_USD)
		);
	});

	test("Arabic formats the amounts with Arabic currency formatting", () => {
		const teams = activationOfferCopy(english, true, "ar");
		const trial = usd("ar", ONBOARDING_TEAMS_OFFER.trialMonthlyPriceUsd);
		expect(teams.amount).toBe(trial);
		expect(teams.amount).not.toBe(
			`$${ONBOARDING_TEAMS_OFFER.trialMonthlyPriceUsd}`
		);
		expect(teams.recurring).toContain(
			usd("ar", ONBOARDING_TEAMS_OFFER.listMonthlyPriceUsd)
		);
	});

	test("every worded line goes through the message function", () => {
		const seen: string[] = [];
		const tl = (source: string, values?: MessageValuesInput) => {
			seen.push(source);
			return `T:${english(source, values)}`;
		};
		for (const organizationPlan of [true, false]) {
			const copy = activationOfferCopy(tl, organizationPlan, "en");
			expect(copy.cadence).toStartWith("T:");
			expect(copy.recurring).toStartWith("T:");
		}
		expect(seen).toContain("{price}/month from month two");
	});
});
