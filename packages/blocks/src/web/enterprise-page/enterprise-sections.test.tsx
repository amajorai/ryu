import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { docsHref } from "../data/resources.tsx";
import { ENTERPRISE_FACTS, ROLLOUT_STEPS } from "./enterprise-data.ts";
import { EnterpriseDeployment } from "./enterprise-deployment.tsx";
import {
	DEPLOYMENT_OPTIONS,
	DEPLOYMENT_ROWS,
} from "./enterprise-deployment-data.ts";
import { EnterpriseGlance, enterpriseFactRows } from "./enterprise-glance.tsx";
import {
	ENTERPRISE_TAG,
	EnterpriseGroupSection,
} from "./enterprise-groups.tsx";
import {
	ENTERPRISE_GATED_NOTE,
	ENTERPRISE_GROUPS,
} from "./enterprise-groups-data.ts";
import { EnterpriseRollout } from "./enterprise-rollout.tsx";

function count(html: string, needle: string): number {
	return html.split(needle).length - 1;
}

/** HTML-escape the way React does for text content. */
function escaped(text: string): string {
	return text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll("'", "&#x27;")
		.replaceAll('"', "&quot;");
}

describe("EnterpriseGroupSection", () => {
	for (const group of ENTERPRISE_GROUPS) {
		test(`${group.id}: a labelled section with every item, tags and a docs link`, () => {
			const html = renderToStaticMarkup(
				<EnterpriseGroupSection group={group} />
			);
			expect(html).toContain(`id="${group.id}"`);
			expect(html).toContain(`aria-labelledby="${group.id}-title"`);
			expect(html).toContain(`id="${group.id}-title"`);
			expect(count(html, "<h2")).toBe(1);
			expect(count(html, "<h3")).toBe(group.items.length);
			for (const item of group.items) {
				expect(html).toContain(escaped(item.title));
				expect(html).toContain(escaped(item.description));
			}
			expect(count(html, "data-enterprise-tag")).toBe(
				group.items.filter((item) => item.enterprise).length
			);
			expect(html).toContain(`href="${docsHref(group.docs.path)}"`);
			expect(html).toContain('rel="noopener noreferrer"');
			expect(html).toContain('target="_blank"');
		});
	}

	test("the tag says Enterprise in words", () => {
		const governance = ENTERPRISE_GROUPS[0];
		if (!governance) {
			throw new Error("missing group");
		}
		const html = renderToStaticMarkup(
			<EnterpriseGroupSection group={governance} />
		);
		expect(html).toContain(`data-enterprise-tag="">${ENTERPRISE_TAG}</span>`);
	});

	test("only the cards layout carries the gating caveat", () => {
		const support = ENTERPRISE_GROUPS[2];
		if (!support) {
			throw new Error("missing group");
		}
		const cards = renderToStaticMarkup(
			<EnterpriseGroupSection group={support} layout="cards" />
		);
		const rows = renderToStaticMarkup(
			<EnterpriseGroupSection group={support} />
		);
		expect(cards).toContain('data-testid="enterprise-gated-note"');
		expect(cards).toContain(escaped(ENTERPRISE_GATED_NOTE.text));
		expect(cards).toContain('data-enterprise-layout="cards"');
		expect(count(cards, "data-product-card")).toBe(support.items.length);
		expect(rows).not.toContain("enterprise-gated-note");
		expect(rows).toContain('data-enterprise-layout="rows"');
	});
});

describe("EnterpriseDeployment", () => {
	const html = renderToStaticMarkup(<EnterpriseDeployment />);

	test("is a real table with column and row headers and a caption", () => {
		expect(html).toContain('id="deployment"');
		expect(html).toContain("<caption");
		expect(html).toContain(`data-column-count="${DEPLOYMENT_OPTIONS.length}"`);
		expect(count(html, 'scope="col"')).toBe(DEPLOYMENT_OPTIONS.length + 1);
		expect(count(html, 'scope="row"')).toBe(DEPLOYMENT_ROWS.length);
		for (const option of DEPLOYMENT_OPTIONS) {
			expect(html).toContain(`data-deployment-option="${option.id}"`);
			expect(html).toContain(escaped(option.name));
		}
	});

	test("the table shows every cell in its column's order", () => {
		const table = html.slice(html.indexOf("<table"), html.indexOf("</table>"));
		for (const row of DEPLOYMENT_ROWS) {
			const start = table.indexOf(escaped(row.label));
			expect(start).toBeGreaterThan(-1);
			let last = start;
			for (const cell of row.cells) {
				const at = table.indexOf(escaped(cell.text), last);
				expect(at).toBeGreaterThan(last);
				last = at;
			}
		}
	});

	test("phones get one card per option instead, and the table is hidden below md", () => {
		const cards = html.slice(
			html.lastIndexOf(
				"<ol",
				html.indexOf('data-testid="enterprise-deployment-cards"')
			),
			html.indexOf("<table")
		);
		expect(cards).toContain("md:hidden");
		expect(html).toContain(
			'class="relative hidden md:block" data-scroll-region=""'
		);
		const items = cards.split("<li").slice(1);
		expect(items).toHaveLength(DEPLOYMENT_OPTIONS.length);
		items.forEach((item, index) => {
			expect(item).toContain(escaped(DEPLOYMENT_OPTIONS[index]?.name ?? ""));
			for (const row of DEPLOYMENT_ROWS) {
				expect(item).toContain(escaped(row.label));
				expect(item).toContain(escaped(row.cells[index]?.text ?? ""));
			}
		});
	});

	test("links the open-core and infra docs in a new tab", () => {
		expect(html).toContain(
			`href="${docsHref("/docs/start-here/architecture/open-core")}"`
		);
		expect(html).toContain(
			`href="${docsHref("/docs/start-here/architecture/three-products")}"`
		);
	});
});

describe("EnterpriseGlance", () => {
	test("renders every fact as a label/value row, with the repo link external", () => {
		const html = renderToStaticMarkup(<EnterpriseGlance />);
		expect(html).toContain('id="at-a-glance"');
		expect(html).toContain('data-testid="enterprise-facts"');
		expect(count(html, "<dt")).toBe(ENTERPRISE_FACTS.length);
		for (const fact of ENTERPRISE_FACTS) {
			expect(html).toContain(escaped(fact.label));
			expect(html).toContain(escaped(fact.value));
		}
		expect(html).toContain('href="https://github.com/amajorai/ryu"');
	});

	test("fact rows drop their sources", () => {
		for (const row of enterpriseFactRows()) {
			expect(Object.keys(row)).not.toContain("source");
		}
	});
});

describe("EnterpriseRollout", () => {
	const html = renderToStaticMarkup(<EnterpriseRollout />);

	test("numbers the docs' rollout steps in order", () => {
		expect(html).toContain('id="rollout"');
		expect(count(html, "<li")).toBe(ROLLOUT_STEPS.length);
		let last = -1;
		for (const step of ROLLOUT_STEPS) {
			const at = html.indexOf(escaped(step.title));
			expect(at).toBeGreaterThan(last);
			last = at;
		}
		expect(html).toContain(">05<");
	});

	test("puts both identity-provider URLs in the server HTML as tabs", () => {
		expect(html).toContain('role="tablist"');
		expect(html).toContain('aria-label="Identity provider URLs"');
		expect(html).toContain(
			escaped("https://<your-ryu-auth-host>/api/auth/scim/v2")
		);
		expect(html).toContain(
			escaped(
				"https://<your-ryu-auth-host>/api/auth/sso/saml2/sp/acs/<provider-id>"
			)
		);
	});
});
