import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { COMPANY } from "./data/company.ts";
import { DOCS_URL, docsHref } from "./data/resources.tsx";
import Footer, {
	FOOTER_COLUMNS,
	footerColumnListClass,
	footerColumnsFor,
	footerHref,
} from "./footer.tsx";
import { FOOTER_DOCS_HOME } from "./footer-links.ts";

const escapeAttr = (value: string) => value.replaceAll("&", "&amp;");

/** The markup between one column heading and the next. */
function columnHtml(html: string, title: string) {
	const start = html.indexOf(`data-footer-column="${title}"`);
	const end = html.indexOf("</ul>", start);
	return start === -1 ? "" : html.slice(start, end);
}

test("footer stays plain: no oversized mark or gradient wash", () => {
	const html = renderToStaticMarkup(<Footer />);

	expect(html).not.toContain('data-testid="footer-ryu-logo"');
	expect(html).not.toContain('data-testid="aurora"');
	expect(html).not.toContain(">ryu</div>");
});

test("footer spans the full viewport width", () => {
	const html = renderToStaticMarkup(<Footer />);

	expect(html).toContain('class="w-full px-6 md:px-10 lg:px-16"');
	expect(html).not.toContain("max-w-6xl");
	expect(html).not.toContain("container relative");
});

test("footer carries the homepage positioning line at every width", () => {
	const html = renderToStaticMarkup(<Footer />);
	const lead = html.slice(html.indexOf('data-testid="footer-lead"'));

	expect(lead).toContain("Run agents with the tools and rules they need.");
	// The line used to be hidden below lg; it now opens the footer on phones too.
	expect(lead.slice(0, lead.indexOf("Run agents"))).not.toContain(
		"hidden lg:block"
	);
	expect(html).not.toContain("The universal AI integration layer");
	expect(html).not.toContain("Ryu is the integration layer for AI.");
	expect(html).not.toContain("Backed by");
});

test("footer renders six columns: disclosures on phones, then 3 and 6 across", () => {
	const html = renderToStaticMarkup(<Footer />);
	const nav = html.slice(html.indexOf('aria-label="Footer"') - 200);

	expect(nav).toContain(
		"grid grid-cols-1 py-8 md:grid-cols-3 md:gap-x-8 md:gap-y-10 md:py-16 xl:grid-cols-6"
	);
	for (const column of FOOTER_COLUMNS) {
		const section = columnHtml(html, column.title);
		expect([column.title, section.length > 0]).toEqual([column.title, true]);
		for (const link of column.links) {
			expect(section).toContain(`href="${escapeAttr(footerHref(link))}"`);
		}
	}
	expect(html).not.toContain(">Agent APIs<");
	expect(html).not.toContain('href="/products/os"');
});

test("footer keeps GitHub and its star count in the build row", () => {
	const html = renderToStaticMarkup(<Footer githubStargazersCount={1234} />);

	expect(columnHtml(html, "Resources")).not.toContain("Open Source");
	expect(html.match(/aria-label="Ryu on GitHub"/g)).toHaveLength(1);
	expect(html.match(/github\.com\/amajorai"/g)).toBeNull();
	expect(html).toContain("1,234");
});

test("footer community row names X and Discord, not Product Hunt", () => {
	const html = renderToStaticMarkup(<Footer />);
	const community = html.slice(html.indexOf('aria-label="Community"'));

	expect(community).toContain('aria-label="Ryu on X"');
	expect(html).not.toContain("Product Hunt");
	expect(html).not.toContain("producthunt.com");
	expect(community).toContain('aria-label="Ryu on Discord"');
	expect(community).toContain('href="/community"');
	expect(community).toContain('href="https://x.com/ryuhq"');
});

test("footer leads with a Download call to action", () => {
	const html = renderToStaticMarkup(<Footer />);
	const start = html.slice(html.indexOf('aria-label="Get started"'));
	const order = ["/download", "/pricing", "/subscriptions", "/login"].map(
		(href) => start.indexOf(`href="${href}"`)
	);

	expect(order.every((index) => index > 0)).toBe(true);
	expect([...order].sort((a, b) => a - b)).toEqual(order);
	// Download is the solid pill; the rest are outlined.
	const download = start.slice(0, start.indexOf('href="/download"'));
	expect(download.slice(download.lastIndexOf("<a"))).toContain("bg-foreground");
});

test("footer accepts the website controls", () => {
	const html = renderToStaticMarkup(
		<Footer
			cookieSettings={<button type="button">Cookie settings</button>}
			languagePicker={<span>Language picker</span>}
			soundToggle={<span>Sound toggle</span>}
		/>
	);

	expect(html).toContain("Language picker");
	expect(html).toContain("Sound toggle");
	const legal = html.slice(html.indexOf('aria-label="Legal"'));
	expect(legal.indexOf("Subprocessors")).toBeLessThan(
		legal.indexOf("Cookie settings")
	);
});

test("legal links live only in the legal row, and Contact appears once", () => {
	const html = renderToStaticMarkup(<Footer />);
	const legal = html.slice(
		html.indexOf('aria-label="Legal"'),
		html.indexOf("</nav>", html.indexOf('aria-label="Legal"'))
	);

	for (const href of ["/privacy", "/terms", "/dpa", "/subprocessors"]) {
		expect(html.match(new RegExp(`href="${href}"`, "g"))).toHaveLength(1);
		expect(legal).toContain(`href="${href}"`);
	}
	expect(html.match(/href="\/contact"/g)).toHaveLength(1);
	expect(html).not.toContain(">Legal &amp; Trust<");
});

test("footer copyright reads the company record", () => {
	const html = renderToStaticMarkup(<Footer />);

	expect(html).toContain(`<span itemProp="name">${COMPANY.legalName}</span>`);
	expect(html).toContain(`<span itemProp="taxID">${COMPANY.uen}</span>`);
	expect(html).toContain(
		`content="${COMPANY.foundingDate}" itemProp="foundingDate"`
	);
});

test("docs links go to the docs site in a new tab", () => {
	expect(
		footerHref({ href: FOOTER_DOCS_HOME, kind: "docs", label: "Docs" })
	).toBe(DOCS_URL);
	expect(
		footerHref({
			href: "/docs/standalone/sdk/openapi",
			kind: "docs",
			label: "API reference",
		})
	).toBe(docsHref("/docs/standalone/sdk/openapi"));

	const html = renderToStaticMarkup(<Footer />);
	const apiLink = html.slice(
		html.lastIndexOf("<a", html.indexOf(">API reference<")),
		html.indexOf(">API reference<")
	);
	expect(apiLink).toContain('target="_blank"');
	expect(apiLink).toContain('rel="noopener noreferrer"');
});

test("footer leaves out the products the host has not launched", () => {
	const hidden = ["agents-as-a-service", "red-team", "workflows", "mail"];
	const html = renderToStaticMarkup(<Footer hiddenProductIds={hidden} />);

	expect(html).not.toContain('href="/products/agents-as-a-service"');
	expect(html).not.toContain('href="/products/red-team"');
	expect(html).not.toContain('href="/products/workflows"');
	expect(html).not.toContain('href="/products/mail"');
	expect(html).toContain('href="/products/core"');
	expect(
		footerColumnsFor(hidden)
			.find((column) => column.title === "Platform")
			?.links.map((link) => link.label)
	).toEqual([
		"Ryu Core",
		"Ryu Gateway",
		"Ryu Cloud",
		"Self-hosted",
		"How it fits together",
	]);
});

test("footer without a hidden list renders every column link", () => {
	const html = renderToStaticMarkup(<Footer />);

	expect(html).toContain('href="/products/agents-as-a-service"');
	expect(html).toContain('href="/products/mail"');
	const hrefs = (columns: typeof FOOTER_COLUMNS) =>
		columns.flatMap((column) => column.links.map((link) => link.href));
	expect(hrefs(footerColumnsFor())).toEqual(hrefs(FOOTER_COLUMNS));
});

test("below md each column title is a collapsed disclosure over its links", () => {
	const html = renderToStaticMarkup(<Footer />);
	const toggles = [
		...html.matchAll(
			/<button aria-controls="([^"]+)" aria-expanded="false"[^>]*md:hidden[^>]*>/g
		),
	];
	expect(toggles).toHaveLength(FOOTER_COLUMNS.length);
	for (const [, listId] of toggles) {
		// Each button controls a real list that stays in the markup.
		expect(html).toContain(
			`<ul class="hidden md:block md:pb-0" id="${listId}">`
		);
	}
	// From md up the title is plain heading text and every list shows.
	expect(html.match(/<span class="max-md:hidden">/g)).toHaveLength(
		FOOTER_COLUMNS.length
	);
	expect(footerColumnListClass(false)).toBe("hidden md:block md:pb-0");
	expect(footerColumnListClass(true)).toBe("pb-4 md:block md:pb-0");
});

test("the tagline uses the heading face, as the docs footer does", () => {
	const html = renderToStaticMarkup(<Footer />);
	expect(html).toContain(
		'class="max-w-md text-balance font-heading font-medium text-2xl md:text-3xl"'
	);
});
