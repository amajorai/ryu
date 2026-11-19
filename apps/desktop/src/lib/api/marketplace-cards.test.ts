import { expect, test } from "bun:test";
import {
	type MarketplaceCardWire,
	toMarketplaceCard,
} from "./marketplace-cards.ts";

const wire: MarketplaceCardWire = {
	author: null,
	category: null,
	description: null,
	firstParty: false,
	iconUrl: null,
	id: "sample",
	installSource: null,
	kind: "plugin",
	name: "Sample",
	pricing: null,
	ratingAverage: 0,
	ratingCount: 0,
	version: "1.0",
};

test("fills absent optional card fields with stable defaults", () => {
	const card = toMarketplaceCard(wire);
	expect(card.artifactKinds).toEqual([]);
	expect(card.bundleMemberCount).toBe(0);
	expect(card.communityStats).toEqual({ downloads: 0, instances: 0, runs: 0 });
	expect(card.likeCount).toBe(0);
	expect(card.likedByMe).toBe(false);
	expect(card.pricing).toBeNull();
	expect(card.targets).toEqual([]);
	expect(card.verification).toBe("unknown");
});

test("resolves the verification status from every wire spelling", () => {
	expect(toMarketplaceCard({ ...wire, verified: true }).verification).toBe(
		"verified"
	);
	expect(toMarketplaceCard({ ...wire, verified: false }).verification).toBe(
		"invalid"
	);
	expect(
		toMarketplaceCard({ ...wire, verified: "unsigned" }).verification
	).toBe("unsigned");
	expect(toMarketplaceCard({ ...wire, firstParty: true }).verification).toBe(
		"verified"
	);
	const card = toMarketplaceCard({ ...wire, verified: true });
	expect("verified" in card).toBe(false);
});
