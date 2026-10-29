import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import Footer, { FOOTER_COLUMNS, footerColumnsFor } from "./footer.tsx";

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

test("footer carries the homepage positioning line", () => {
	const html = renderToStaticMarkup(<Footer />);

	expect(html).toContain("Run agents with the tools and rules they need.");
	expect(html).not.toContain("The universal AI integration layer");
	expect(html).not.toContain("Connect the tools it needs");
	expect(html).not.toContain("Ryu is the integration layer for AI.");
	expect(html).not.toContain("We deploy and run AI agents safely in the cloud");
	expect(html).not.toContain("Autonomous AI in the cloud");
	expect(html).not.toContain("Backed by");
});

test("footer keeps GitHub and its star count in the build row", () => {
	const html = renderToStaticMarkup(<Footer githubStargazersCount={1234} />);
	const resourcesColumn = html.slice(
		html.indexOf('<h3 class="mb-4 font-medium">Resources</h3>'),
		html.indexOf('<h3 class="mb-4 font-medium">Company</h3>')
	);

	expect(resourcesColumn).not.toContain("Open Source");
	expect(html.match(/aria-label="Ryu on GitHub"/g)).toHaveLength(1);
	expect(html).toContain("1,234");
});

test("footer accepts the website controls", () => {
	const html = renderToStaticMarkup(
		<Footer
			languagePicker={<span>Language picker</span>}
			soundToggle={<span>Sound toggle</span>}
		/>
	);

	expect(html).toContain("Language picker");
	expect(html).toContain("Sound toggle");
});

test("footer link columns follow the product taxonomy without duplicates", () => {
	expect(FOOTER_COLUMNS.map((column) => column.title)).toEqual([
		"Products",
		"Platform",
		"Resources",
		"Company",
		"Get started",
	]);
	for (const column of FOOTER_COLUMNS) {
		expect(column.links.length).toBeGreaterThanOrEqual(4);
		expect(column.links.length).toBeLessThanOrEqual(6);
	}
	const hrefs = FOOTER_COLUMNS.flatMap((column) =>
		column.links.map((link) => link.href)
	);
	expect(new Set(hrefs).size).toBe(hrefs.length);

	const html = renderToStaticMarkup(<Footer />);
	expect(html).not.toContain("Ryu Infra");
	expect(html).toContain('href="/products/cloud"');
	expect(html.match(/href="\/contact"/g)).toHaveLength(1);
});

test("footer products lead with released products and platform ends with services", () => {
	const [products, platform] = FOOTER_COLUMNS;
	expect(products?.links.map((link) => link.label)).toEqual([
		"Ryu Desktop",
		"Bot",
		"Agent",
		"Marketplace",
		"All products",
	]);
	expect(platform?.links.map((link) => link.label)).toEqual([
		"Ryu Core",
		"Ryu Gateway",
		"Ryu Cloud",
		"Agents as a Service",
		"Red Teaming",
	]);
	expect(renderToStaticMarkup(<Footer />)).not.toContain('href="/products/os"');
});

test("footer leaves out the products the host has not launched", () => {
	const hidden = ["agents-as-a-service", "red-team", "workflows"];
	const html = renderToStaticMarkup(<Footer hiddenProductIds={hidden} />);

	expect(html).not.toContain('href="/products/agents-as-a-service"');
	expect(html).not.toContain('href="/products/red-team"');
	expect(html).toContain('href="/products/core"');
	expect(html).toContain('href="/products/cloud"');
	expect(
		footerColumnsFor(hidden)
			.find((column) => column.title === "Platform")
			?.links.map((link) => link.label)
	).toEqual(["Ryu Core", "Ryu Gateway", "Ryu Cloud"]);
	// Hiding is render-only: the shared column data still lists both.
	expect(FOOTER_COLUMNS[1]?.links.map((link) => link.href)).toContain(
		"/products/red-team"
	);
});

test("footer without a hidden list renders every column link", () => {
	const html = renderToStaticMarkup(<Footer />);

	expect(html).toContain('href="/products/agents-as-a-service"');
	expect(html).toContain('href="/products/red-team"');
	const hrefs = (columns: typeof FOOTER_COLUMNS) =>
		columns.flatMap((column) => column.links.map((link) => link.href));
	expect(hrefs(footerColumnsFor())).toEqual(hrefs(FOOTER_COLUMNS));
});
