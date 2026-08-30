import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PricingInstancePicker } from "./pricing.tsx";

test("pricing cloud instances use server terminology", () => {
	const html = renderToStaticMarkup(
		<PricingInstancePicker
			instances={[
				{
					availableInLocation: true,
					cores: 2,
					diskGb: 40,
					includedWithMax: false,
					memoryGb: 4,
					monthlyUsd: 12,
					perfLabel: "Balanced",
					type: "cx23",
				},
			]}
			locations={[]}
		/>
	);

	expect(html).toContain("We host your server");
	expect(html).toContain("Deploy server");
	expect(html).not.toContain("Deploy node");
	expect(html).not.toContain("managed node");
});
