// The shared "can't show the money layer" empty states render their injected
// copy verbatim (signed-out and no-organization placeholders). Static markup,
// no DOM.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { NoOrgState, SignedOutState } from "./states.tsx";

describe("SignedOutState", () => {
	test("renders the provided title and description", () => {
		const html = renderToStaticMarkup(
			<SignedOutState
				description="Log in to continue."
				title="Sign in required"
			/>
		);
		expect(html).toContain("Sign in required");
		expect(html).toContain("Log in to continue.");
	});
});

describe("NoOrgState", () => {
	test("renders the provided title and message", () => {
		const html = renderToStaticMarkup(
			<NoOrgState message="Pick an org first." title="No organization" />
		);
		expect(html).toContain("No organization");
		expect(html).toContain("Pick an org first.");
	});
});
