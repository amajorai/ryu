import { expect, test } from "bun:test";
import * as facade from "./marketplace.ts";
import * as catalog from "./marketplace-catalog.ts";
import * as community from "./marketplace-community.ts";
import * as detail from "./marketplace-detail.ts";
import * as http from "./marketplace-http.ts";
import * as membership from "./marketplace-membership.ts";
import * as portable from "./marketplace-portable-packages.ts";
import * as privateShare from "./marketplace-private-share.ts";
import * as publish from "./marketplace-publish.ts";
import * as reports from "./marketplace-reports.ts";
import * as reviews from "./marketplace-reviews.ts";

test("the facade re-exports the split modules' own runtime bindings", () => {
	expect(facade.fetchCatalogPage).toBe(catalog.fetchCatalogPage);
	expect(facade.likeItem).toBe(community.likeItem);
	expect(facade.fetchDetail).toBe(detail.fetchDetail);
	expect(facade.MarketplaceError).toBe(http.MarketplaceError);
	expect(facade.hasMarketplaceAuth).toBe(membership.hasMarketplaceAuth);
	expect(facade.installPortablePackage).toBe(portable.installPortablePackage);
	expect(facade.redeemPrivatePackageShareCode).toBe(
		privateShare.redeemPrivatePackageShareCode
	);
	expect(facade.publishRunnable).toBe(publish.publishRunnable);
	expect(facade.submitReport).toBe(reports.submitReport);
	expect(facade.postReview).toBe(reviews.postReview);
});

test("the facade keeps internal helpers private", () => {
	const exported = Object.keys(facade);
	for (const internal of [
		"authHeaders",
		"BASE",
		"toError",
		"toMarketplaceCard",
	]) {
		expect(exported).not.toContain(internal);
	}
	expect(exported).toHaveLength(44);
});
