import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MarketplaceItemCard } from "./marketplace.tsx";

test("renders a bundle install affordance and its community summary", () => {
	const html = renderToStaticMarkup(
		<MarketplaceItemCard
			card={{
				author: "Ryu",
				bundleMemberCount: 3,
				communityStats: { downloads: 12, instances: 4, runs: 8 },
				description: "A curated collection.",
				id: "ryu/bundle/demo",
				kind: "bundle",
				name: "Demo Bundle",
				onInstall: () => undefined,
				owned: false,
				priceLabel: null,
				verification: "verified",
				version: "1.0.0",
			}}
		/>
	);

	expect(html).toContain("Install bundle");
	expect(html).toContain("3 items · one-click install");
	// One meta line: the bundle size wins; community usage is in the detail.
	expect(html).not.toContain("Community · 12 installs · 8 runs");
});

test("public app cards use the same native artwork instead of an old remote thumbnail", () => {
	const html = renderToStaticMarkup(
		<MarketplaceItemCard
			card={{
				id: "ryu/browser",
				name: "Browser",
				kind: "app",
				author: "Ryu",
				description: null,
				iconUrl: "https://example.com/legacy-thumbnail.png",
				owned: false,
				priceLabel: null,
				verification: "verified",
				version: "1.0.0",
			}}
		/>
	);
	expect(html).toContain('data-app-icon="layered"');
	expect(html).toContain("ryu--browser-light.png");
	expect(html).not.toContain("legacy-thumbnail.png");
});
