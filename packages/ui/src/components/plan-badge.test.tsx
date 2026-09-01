import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PlanBadge } from "./plan-badge.tsx";

describe("Business plan badge", () => {
	test("renders the Business label and title", () => {
		const html = renderToStaticMarkup(<PlanBadge plan="business" size="md" />);

		expect(html).toContain("BUSINESS");
		expect(html).toContain('title="Ryu Business"');
	});
});

describe("A Major Pass plan badge", () => {
	test("renders its own label, title, and palette", () => {
		const html = renderToStaticMarkup(
			<PlanBadge plan="marketplace-membership" size="md" />
		);

		expect(html).toContain("A MAJOR PASS");
		expect(html).toContain('title="Ryu A Major Pass"');
		expect(html).toContain("#c8942e");
	});
});

describe("Enterprise plan badge", () => {
	test("renders the original green enterprise palette", () => {
		const html = renderToStaticMarkup(
			<PlanBadge plan="enterprise" size="md" />
		);

		expect(html).toContain("ENTERPRISE");
		expect(html).toContain("#0f766e");
		expect(html).toContain("#059669");
		expect(html).toContain("#84cc16");
		expect(html).toContain("#f59e0b");
	});
});
