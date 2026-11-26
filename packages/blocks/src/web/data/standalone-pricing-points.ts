import { formatMessage } from "@ryu/i18n/core";
import type { LiteralMessage } from "@ryu/i18n/react";
import { PUBLISHED_PRICING } from "./standalone-pricing-figures.ts";
import { pricingFormat } from "./standalone-pricing-locale.ts";

/**
 * One headline figure on a standalone product's pricing card: the amount a
 * buyer scans for ("$0.025") and what it is charged per ("Small, per hour").
 */
export interface StandalonePricePoint {
	id: string;
	unit: string;
	value: string;
}

const PER_THOUSAND = 1000;

const englishLiteral: LiteralMessage = (source, values) =>
	formatMessage(source, values);

/**
 * The headline figures for one standalone product, built from
 * {@link PUBLISHED_PRICING} so a card can never show a rate the published
 * price sentence does not. Products with no published rate (Sites, Hire)
 * return none, and their card shows the price sentence alone.
 */
export function standalonePricePoints(
	slug: string,
	tl: LiteralMessage = englishLiteral,
	locale?: string | null
): readonly StandalonePricePoint[] {
	const f = pricingFormat(locale);
	const { box, connect, notify, passport } = PUBLISHED_PRICING;
	switch (slug) {
		case "gateway":
			return [
				{
					id: "managed",
					value: tl("At cost"),
					unit: tl("Managed model use, no per-token markup"),
				},
				{ id: "self-hosted", value: tl("Free"), unit: tl("Self-hosted") },
			];
		case "passport":
			return [
				{
					id: "connections",
					value: f.usd(passport.connectionMonthUsd, 2),
					unit: tl("per connection-month"),
				},
				{
					id: "fetches",
					value: f.usd(passport.fetchesPer1000Usd, 2),
					unit: tl("per {count, plural, one {# fetch} other {# fetches}}", {
						count: PER_THOUSAND,
					}),
				},
			];
		case "connect":
			return [
				{
					id: "composio",
					value: tl("Composio rates"),
					unit: tl("per Composio execution"),
				},
				{
					id: "native-calls",
					value: f.usd(connect.nativeCallsPer1000Usd, 2),
					unit: tl(
						"per {count, plural, one {# native toolkit call} other {# native toolkit calls}}",
						{ count: PER_THOUSAND }
					),
				},
			];
		case "box":
			return [
				{
					id: "small",
					value: f.usdRate(box.smallHourUsd),
					unit: tl("Small, per hour"),
				},
				{
					id: "default",
					value: f.usdRate(box.defaultHourUsd),
					unit: tl("Default, per hour"),
				},
				{
					id: "large",
					value: f.usdRate(box.largeHourUsd),
					unit: tl("Large, per hour"),
				},
			];
		case "notify":
			return [
				{
					id: "events",
					value: f.usd(notify.eventsPer1000Usd, 2),
					unit: tl("per {count, plural, one {# event} other {# events}}", {
						count: PER_THOUSAND,
					}),
				},
			];
		case "mail":
			return [
				{
					id: "baseline",
					value: tl("Free"),
					unit: tl("Baseline for every person"),
				},
			];
		case "messaging":
			return [
				{
					id: "pass-through",
					value: tl("AWS price"),
					unit: tl("Passed through with no markup"),
				},
			];
		default:
			return [];
	}
}
