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
	expect(html).toContain("Community · 12 installs · 8 runs");
});
