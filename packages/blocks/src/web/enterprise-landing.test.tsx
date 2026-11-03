import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import EnterpriseLanding, {
	ENTERPRISE_CONTROLS,
} from "./enterprise-landing.tsx";
import { ENTERPRISE_NAV } from "./enterprise-page/enterprise-data.ts";
import { ENTERPRISE_GROUPS } from "./enterprise-page/enterprise-groups-data.ts";
import { SECTION_ANCHOR_CLASS } from "./product-page/sections/section-nav.tsx";

const html = renderToStaticMarkup(<EnterpriseLanding />);

/** The CTA section's markup (from its marker to the end of the page). */
function ctaHtml(): string {
	return html.slice(html.indexOf('data-testid="product-cta"'));
}

test("enterprise sales links open an addressed inquiry without requiring sign-in", () => {
	const salesLinks = html.match(
		/href="mailto:hello@ryuhq.com\?subject=Ryu%20Enterprise%20inquiry"/g
	);
	expect(salesLinks).toHaveLength(2);
	// The self-hosting tile carries no stray cross-link CTA.
	expect(html).not.toContain("Explore the platform");
});

test("enterprise identity and deployment copy distinguishes eligible controls from agreed requirements", () => {
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

test("enterprise keeps its stage hero, figure, controls grid and closing CTA", () => {
	expect(html).toContain('data-product-hero-layout="stage"');
	expect(html).toContain("Agents your company controls");
	expect(html).not.toContain(">Ryu Enterprise</p>");
	expect(html).toContain('data-testid="product-cta"');
	expect(html).toContain("Ready to bring agents to your org?");
	expect(html).toContain('data-product-figure="passport-cabinet"');
	expect(html).not.toContain("data-product-visual=");
	expect(html).not.toContain("Run it on your own infrastructure");
	for (const control of ENTERPRISE_CONTROLS) {
		expect(html).toContain(control.title);
	}
	expect(html.indexOf("Self-host Core and the Gateway")).toBeGreaterThan(
		html.indexOf("Controls for company-wide use")
	);
	// The priorities strip and hero micro-copy are gone.
	expect(html).not.toContain("Enterprise priorities");
	expect(html).not.toContain("Start with one workflow.");
	// Both CTA pairs end on the same docs link; the CTA carries no "Security" label.
	expect(ctaHtml()).not.toContain(">Security<");
	expect(html.match(/<h1/g)).toHaveLength(1);
});

test("enterprise has its own composition, not the shared bento template", () => {
	// Hero, figure, at a glance, controls, three groups, deployment, rollout, CTA.
	expect(html.match(/<section/g)).toHaveLength(10);
	// The stage hero (one h1) and its figure come first, then the sub-nav.
	expect(html.indexOf("<h1")).toBeLessThan(
		html.indexOf('data-testid="product-section-nav"')
	);
	expect(
		html.lastIndexOf('data-product-figure="passport-cabinet"')
	).toBeLessThan(html.indexOf('data-testid="product-section-nav"'));
	const order = [
		'data-testid="product-section-nav"',
		'data-testid="enterprise-at-a-glance"',
		'data-testid="enterprise-controls"',
		'data-testid="enterprise-group-governance"',
		'data-testid="enterprise-group-security"',
		'data-testid="enterprise-group-support"',
		'data-testid="enterprise-deployment"',
		'data-testid="enterprise-rollout"',
		'data-testid="product-cta"',
	];
	const positions = order.map((marker) => html.indexOf(marker));
	expect(positions.every((position) => position > -1)).toBe(true);
	expect([...positions].sort((a, b) => a - b)).toEqual(positions);
});

test("every sub-nav anchor lands on a section of the page", () => {
	for (const item of ENTERPRISE_NAV) {
		expect(html).toContain(`href="#${item.id}"`);
		expect(html).toContain(`id="${item.id}"`);
	}
});

test("the themed groups vary their treatment: rows, an inverse band, then tiles", () => {
	const security = html.indexOf('data-testid="enterprise-group-security"');
	const band = html.lastIndexOf('data-enterprise-band="inverse"', security);
	expect(band).toBeGreaterThan(
		html.indexOf('data-testid="enterprise-group-governance"')
	);
	expect(html.slice(band - 120, band)).toContain("dark");
	expect(html).toContain(
		'data-enterprise-group="governance" data-enterprise-layout="rows"'
	);
	expect(html).toContain(
		'data-enterprise-group="support" data-enterprise-layout="cards"'
	);
	for (const group of ENTERPRISE_GROUPS) {
		expect(html).toContain(group.title);
	}
	expect(html).toContain('data-testid="enterprise-gated-note"');
});

test("the at-a-glance sheet sits on a muted band and the deployment table compares three options", () => {
	const glance = html.indexOf('data-testid="enterprise-at-a-glance"');
	const muted = html.lastIndexOf('data-enterprise-band="muted"', glance);
	expect(muted).toBeGreaterThan(-1);
	expect(html).toContain('data-column-count="3"');
	expect(html).toContain("Self-hosted Ryu Node");
	expect(html).toContain("Private/Full Ryu Deployment");
});

/** The opening tag of the element carrying `id`, or "" when none renders. */
function openingTagWithId(markup: string, id: string): string {
	return (
		markup.match(new RegExp(`<[a-z]+\\b[^>]*\\bid="${id}"[^>]*>`))?.[0] ?? ""
	);
}

test("the deployment table is a keyboard-focusable region from md up", () => {
	expect(html).toMatch(
		/<div class="relative hidden md:block" data-scroll-region=""><div aria-label="Ryu Cloud, a Self-hosted Ryu Node, and a Private\/Full Ryu Deployment compared" class="relative [^"]*" role="region" tabindex="0">/
	);
});

test("every sub-nav target clears the sticky header and sub-nav", () => {
	expect(ENTERPRISE_NAV.length).toBeGreaterThan(0);
	for (const item of ENTERPRISE_NAV) {
		const tag = openingTagWithId(html, item.id);
		expect([item.id, tag.includes(SECTION_ANCHOR_CLASS)]).toEqual([
			item.id,
			true,
		]);
	}
});
