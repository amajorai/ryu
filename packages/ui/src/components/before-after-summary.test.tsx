import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BeforeAfterSummary } from "./before-after-summary.tsx";

describe("BeforeAfterSummary", () => {
	test("renders the current and next money states together", () => {
		const html = renderToStaticMarkup(
			<BeforeAfterSummary
				current={{
					amount: "$12.40",
					eyebrow: "Current",
					label: "Wallet balance",
				}}
				footer={{ label: "Credits added", value: "$25.00" }}
				next={{
					amount: "$37.40",
					eyebrow: "After top-up",
					label: "Wallet balance",
				}}
			/>
		);

		expect(html).toContain('data-slot="before-after-summary"');
		expect(html).toContain("$12.40");
		expect(html).toContain("$37.40");
		expect(html).toContain("After top-up");
		expect(html).toContain("Credits added");
		// The English accessible name keeps its exact pre-catalog wording.
		expect(html).toContain(
			'aria-label="Current: Wallet balance, $12.40. After top-up: Wallet balance, $37.40."'
		);
	});
});
