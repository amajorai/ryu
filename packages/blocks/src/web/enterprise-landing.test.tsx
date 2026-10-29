import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import EnterpriseLanding from "./enterprise-landing.tsx";

test("enterprise sales links open an addressed inquiry without requiring sign-in", () => {
	const html = renderToStaticMarkup(<EnterpriseLanding />);
	const salesLinks = html.match(
		/href="mailto:hello@ryuhq.com\?subject=Ryu%20Enterprise%20inquiry"/g
	);
	expect(salesLinks).toHaveLength(2);
	// The self-hosting tile carries no stray cross-link CTA.
	expect(html).not.toContain("Explore the platform");
});

test("enterprise identity and deployment copy distinguishes eligible controls from agreed requirements", () => {
	const html = renderToStaticMarkup(<EnterpriseLanding />);
	expect(html).toContain(
		"Single sign-on, SCIM, and audit export turn on with an Enterprise plan or a self-hosted Enterprise license."
	);
	expect(html).not.toContain(
		"Availability depends on your plan and deployment."
	);
	expect(html).not.toContain(
		"Enterprise capabilities depend on your plan and deployment."
	);
	// The controls lead carries the availability caveat once; the row does not repeat it.
	expect(html).not.toContain(
		"Availability and terms are agreed for your deployment."
	);
	// The hero is a text-free figure, not a checklist card.
	expect(html).not.toContain("Illustrative agent workflow");
	expect(html).not.toContain("research preview");
	expect(html).toContain("/docs/security/enterprise-identity");
});

test("enterprise page follows the shared landing template", () => {
	const html = renderToStaticMarkup(<EnterpriseLanding />);
	expect(html).toContain('data-product-hero-layout="stage"');
	expect(html).toContain("Agents your company controls");
	expect(html).toContain("Ryu Enterprise");
	expect(html).toContain('data-testid="product-cta"');
	expect(html).toContain("Ready to bring agents to your org?");
	// A text-only stage hero, its figure, one controls section (self-hosting is a
	// tile), one closing CTA.
	expect(html.match(/<section/g)).toHaveLength(4);
	expect(html).toContain('data-product-figure="passport-cabinet"');
	expect(html).not.toContain("data-product-visual=");
	expect(html).not.toContain("Run it on your own infrastructure");
	expect(html.indexOf("Self-host Core and the Gateway")).toBeGreaterThan(
		html.indexOf("Controls for company-wide use")
	);
	// The priorities strip and hero micro-copy are gone.
	expect(html).not.toContain("Enterprise priorities");
	expect(html).not.toContain("Start with one workflow.");
	// Both CTA pairs end on the same docs link; no off-vocabulary "Security" label.
	expect(html).not.toContain(">Security<");
});
