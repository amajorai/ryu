import { expect, test } from "bun:test";
import { formatMessage } from "@ryu/i18n/core";
import type { LiteralMessage } from "@ryu/i18n/react";
import {
	PUBLISHED_PRICING,
	STANDALONE_PRODUCT_PRICING,
} from "./standalone-pricing.ts";
import { standalonePricePoints } from "./standalone-pricing-points.ts";

const DOLLAR_FIGURE = /^\$\d/u;

const pointsOf = (slug: string) =>
	standalonePricePoints(slug).map((point) => [point.value, point.unit]);

test("every dollar figure on a card is in that product's published price copy", () => {
	for (const entry of STANDALONE_PRODUCT_PRICING) {
		const published = [entry.price, ...entry.details].join(" ");
		for (const point of standalonePricePoints(entry.slug)) {
			if (DOLLAR_FIGURE.test(point.value)) {
				expect([entry.slug, published.includes(point.value)]).toEqual([
					entry.slug,
					true,
				]);
			}
		}
	}
});

test("figures come from the published pricing table", () => {
	const { box, connect, notify, passport } = PUBLISHED_PRICING;
	expect(pointsOf("box")).toEqual([
		[`$${box.smallHourUsd}`, "Small, per hour"],
		[`$${box.defaultHourUsd.toFixed(2)}`, "Default, per hour"],
		[`$${box.largeHourUsd.toFixed(2)}`, "Large, per hour"],
	]);
	expect(pointsOf("passport")).toEqual([
		[`$${passport.connectionMonthUsd.toFixed(2)}`, "per connection-month"],
		[`$${passport.fetchesPer1000Usd.toFixed(2)}`, "per 1,000 fetches"],
	]);
	expect(pointsOf("notify")).toEqual([
		[`$${notify.eventsPer1000Usd.toFixed(2)}`, "per 1,000 events"],
	]);
	expect(pointsOf("connect")).toEqual([
		["Composio rates", "per Composio execution"],
		[
			`$${connect.nativeCallsPer1000Usd.toFixed(2)}`,
			"per 1,000 native toolkit calls",
		],
	]);
});

test("products without a published rate show no figure, and unknown slugs none", () => {
	expect(pointsOf("sites")).toEqual([]);
	expect(pointsOf("hire")).toEqual([]);
	expect(pointsOf("not-a-product")).toEqual([]);
	// Every other published row leads with at least one figure.
	for (const entry of STANDALONE_PRODUCT_PRICING) {
		if (entry.slug !== "sites" && entry.slug !== "hire") {
			expect([
				entry.slug,
				standalonePricePoints(entry.slug).length > 0,
			]).toEqual([entry.slug, true]);
		}
	}
});

test("word figures restate the published price sentence", () => {
	const price = (slug: string) =>
		STANDALONE_PRODUCT_PRICING.find((entry) => entry.slug === slug)?.price ??
		"";
	expect(pointsOf("gateway")).toEqual([
		["At cost", "Managed model use, no per-token markup"],
		["Free", "Self-hosted"],
	]);
	expect(price("gateway")).toContain("Self-hosting is free");
	expect(price("gateway")).toContain(
		"billed at cost, with no per-token markup"
	);
	expect(pointsOf("mail")).toEqual([["Free", "Baseline for every person"]]);
	expect(price("mail")).toContain("Free baseline");
	expect(price("mail")).toContain("once per person");
	expect(pointsOf("messaging")).toEqual([
		["AWS price", "Passed through with no markup"],
	]);
	expect(price("messaging")).toContain(
		"at the AWS End User Messaging price, passed through with no markup"
	);
});

test("units go through the translator and figures follow the locale", () => {
	const german: LiteralMessage = (source, values) =>
		formatMessage(`[de] ${source}`, values, "de");
	const [events] = standalonePricePoints("notify", german, "de");
	expect(events?.unit).toBe("[de] per 1.000 events");
	expect(events?.value).toContain("0,10");
});

test("counted units are ICU plurals that get the count as a number", () => {
	const calls: [string, unknown][] = [];
	const spy: LiteralMessage = (source, values) => {
		const count =
			typeof values === "object" && values !== null && "count" in values
				? values.count
				: undefined;
		calls.push([source, count]);
		return formatMessage(source, values);
	};
	for (const slug of ["passport", "connect", "notify"]) {
		standalonePricePoints(slug, spy);
	}
	const counted = calls.filter(([, count]) => count !== undefined);
	expect(counted).toEqual([
		["per {count, plural, one {# fetch} other {# fetches}}", 1000],
		[
			"per {count, plural, one {# native toolkit call} other {# native toolkit calls}}",
			1000,
		],
		["per {count, plural, one {# event} other {# events}}", 1000],
	]);
	expect(formatMessage(counted[0]?.[0] ?? "", { count: 1 })).toBe(
		"per 1 fetch"
	);
});
