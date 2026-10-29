import { describe, expect, test } from "bun:test";
import {
	ONBOARDING_OFFER_METADATA_KEY,
	ONBOARDING_OFFER_METADATA_VALUE,
	ONBOARDING_OFFER_OWNER_METADATA_KEY,
	onboardingOfferRedemptionFilters,
} from "./onboarding-offer.ts";

describe("onboarding offer redemption lookup", () => {
	test("searches the owner stamp and the legacy initiator stamp for each account", () => {
		expect(onboardingOfferRedemptionFilters(["owner", "admin"])).toEqual([
			{
				[ONBOARDING_OFFER_METADATA_KEY]: ONBOARDING_OFFER_METADATA_VALUE,
				[ONBOARDING_OFFER_OWNER_METADATA_KEY]: "owner",
			},
			{
				[ONBOARDING_OFFER_METADATA_KEY]: ONBOARDING_OFFER_METADATA_VALUE,
				userId: "owner",
			},
			{
				[ONBOARDING_OFFER_METADATA_KEY]: ONBOARDING_OFFER_METADATA_VALUE,
				[ONBOARDING_OFFER_OWNER_METADATA_KEY]: "admin",
			},
			{
				[ONBOARDING_OFFER_METADATA_KEY]: ONBOARDING_OFFER_METADATA_VALUE,
				userId: "admin",
			},
		]);
	});

	test("deduplicates the owner who is also the initiator and drops blanks", () => {
		expect(
			onboardingOfferRedemptionFilters([
				"owner",
				" owner ",
				null,
				"",
				undefined,
			])
		).toHaveLength(2);
		expect(onboardingOfferRedemptionFilters([null, " "])).toEqual([]);
	});
});
