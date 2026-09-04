import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ActivationValueStep } from "./ActivationValueStep.tsx";

describe("activation value pricing", () => {
	test("shows personal pricing for a personal workspace", () => {
		const html = renderToStaticMarkup(
			<ActivationValueStep onContinue={() => undefined} />
		);

		expect(html).toContain("$49");
		expect(html).toContain("per month for one person");
		expect(html).not.toContain("$250/month from month two");
	});

	test("shows Teams pricing for an organization workspace", () => {
		const html = renderToStaticMarkup(
			<ActivationValueStep onContinue={() => undefined} organizationPlan />
		);

		expect(html).toContain("$50");
		expect(html).toContain("$250/month from month two");
	});
});
