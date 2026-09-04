import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { NodePersonalizationStep } from "./NodePersonalizationStep.tsx";

const baseProps = {
	onContinue: () => undefined,
};

describe("node onboarding personalization", () => {
	test("shows concise personal and team choices", () => {
		const html = renderToStaticMarkup(
			<NodePersonalizationStep {...baseProps} />
		);

		expect(html).toContain("How will you use this node?");
		expect(html).toContain("Personal use");
		expect(html).toContain("Team or company use");
		expect(html).toContain("Set the context for this node");
		expect(html).not.toContain("Set the context for this node.");
		expect(html).toContain("Keep personal details private to this node.");
		expect(html).toContain("Build shared company knowledge for this node.");
		expect(html).not.toContain("Choose a mode");
		expect(html).toContain("onboarding-node-setup");
	});

	test("renders one concise company field when resumed in team mode", () => {
		const html = renderToStaticMarkup(
			<NodePersonalizationStep
				{...baseProps}
				companyContext="We build reviewable tools."
				initialSetupKind="team"
			/>
		);

		expect(html).toContain("More information about your company");
		expect(html).not.toContain("Build shared company knowledge next");
		expect(html).toContain("We build reviewable tools.");
	});
});
