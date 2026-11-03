import { expect, test } from "bun:test";
import { Briefcase } from "lucide-react";
import { renderToStaticMarkup } from "react-dom/server";
import { DatedList, type DatedListItem } from "./dated-list.tsx";
import { EmptyState } from "./empty-state.tsx";
import { FactSheet } from "./fact-sheet.tsx";

const FACTS = [
	{ label: "Company", value: "A Major Pte. Ltd." },
	{ label: "Press", value: "Brand assets", href: "/press#brand-assets" },
	{
		label: "Website",
		value: "amajor.ai",
		href: "https://amajor.ai",
		external: true,
	},
] as const;

test("FactSheet renders a definition list with its title and links", () => {
	const html = renderToStaticMarkup(
		<FactSheet facts={FACTS} testId="company-facts" title="Company facts" />
	);
	expect(html).toContain('data-testid="company-facts"');
	expect(html).toMatch(/<h2[^>]*>Company facts<\/h2>/);
	expect(html.match(/<dt/g)?.length).toBe(3);
	expect(html.match(/<dd/g)?.length).toBe(3);
	expect(html).toContain("<dd");
	expect(html).toMatch(
		/<dt[^>]*>Company<\/dt><dd[^>]*>A Major Pte\. Ltd\.<\/dd>/
	);
	expect(html).toContain('href="/press#brand-assets"');
	expect(html).toMatch(
		/<a[^>]*href="https:\/\/amajor\.ai"[^>]*rel="noopener noreferrer"[^>]*target="_blank"/
	);
});

test("FactSheet supports an h3 title, no title, and renders nothing when empty", () => {
	expect(
		renderToStaticMarkup(
			<FactSheet facts={FACTS} headingLevel="h3" title="At a glance" />
		)
	).toMatch(/<h3[^>]*>At a glance<\/h3>/);
	const untitled = renderToStaticMarkup(<FactSheet facts={FACTS} />);
	expect(untitled).not.toMatch(/<h[23]/);
	expect(untitled).toContain("<dl");
	expect(renderToStaticMarkup(<FactSheet facts={[]} title="Empty" />)).toBe("");
});

test("FactSheet column count maps to fixed grid classes", () => {
	const html = renderToStaticMarkup(<FactSheet columns={4} facts={FACTS} />);
	expect(html).toContain("lg:grid-cols-4");
	expect(
		renderToStaticMarkup(<FactSheet columns={2} facts={FACTS} />)
	).not.toContain("lg:grid-cols");
});

const ITEMS: DatedListItem[] = [
	{
		id: "newer",
		title: "Ryu 1.2",
		href: "/changelog/ryu-1-2",
		date: "2026-10-30",
		tag: "Product news",
	},
	{
		id: "older",
		title: "Launch coverage",
		href: "https://example.com/story",
		date: "2026-05",
		meta: "Example Outlet",
		external: true,
	},
	{ id: "undated", title: "On demand", href: "/academy" },
];

test("DatedList renders rows in the caller's order with machine-readable dates", () => {
	const html = renderToStaticMarkup(
		<DatedList
			emptyState={<p>Nothing yet</p>}
			items={ITEMS}
			testId="announcements"
			title="Announcements"
		/>
	);
	expect(html).toContain('data-testid="announcements"');
	expect(html).toContain('data-count="3"');
	expect(html).toMatch(/<h3[^>]*>Announcements<\/h3>/);
	expect(html).toContain('<time dateTime="2026-10-30">Oct 30, 2026</time>');
	expect(html).toContain('<time dateTime="2026-05">May 2026</time>');
	expect(html.match(/<time/g)?.length).toBe(2);
	expect(html.indexOf("Ryu 1.2")).toBeLessThan(html.indexOf("Launch coverage"));
	expect(html.indexOf("Launch coverage")).toBeLessThan(
		html.indexOf("On demand")
	);
	expect(html).toContain("Product news");
	expect(html).toContain("Example Outlet");
	expect(html).toContain('href="/changelog/ryu-1-2"');
	expect(html).toMatch(
		/<a[^>]*href="https:\/\/example\.com\/story"[^>]*rel="noopener noreferrer"[^>]*target="_blank"/
	);
	expect(html).toContain("(opens in a new tab)");
	expect(html).not.toContain("Nothing yet");
});

test("DatedList shows its empty state, and no list, when there are no items", () => {
	const html = renderToStaticMarkup(
		<DatedList
			emptyState={<p data-testid="none">Nothing yet</p>}
			items={[]}
			testId="roles"
		/>
	);
	expect(html).toContain('data-count="0"');
	expect(html).toContain('data-testid="none"');
	expect(html).not.toContain("<ul");
});

test("EmptyState states the situation and offers the next steps", () => {
	const html = renderToStaticMarkup(
		<EmptyState
			actions={[
				{ label: "Contact us", href: "/contact" },
				{ label: "hello@ryuhq.com", href: "mailto:hello@ryuhq.com" },
			]}
			body="We will list roles here when we are hiring."
			icon={Briefcase}
			testId="roles-empty"
			title="No open roles right now"
		/>
	);
	expect(html).toContain('data-testid="roles-empty"');
	expect(html).toContain("data-empty-state");
	expect(html).toMatch(/<h3[^>]*>No open roles right now<\/h3>/);
	expect(html).toContain("We will list roles here when we are hiring.");
	expect(html).toContain('href="/contact"');
	expect(html).toMatch(
		/<a[^>]*href="mailto:hello@ryuhq\.com"[^>]*>hello@ryuhq\.com<\/a>/
	);
	expect(html.indexOf("Contact us")).toBeLessThan(html.indexOf("mailto:"));
	expect(html).toContain('aria-hidden="true"');
});

test("EmptyState can be a section-level heading and needs no actions", () => {
	const html = renderToStaticMarkup(
		<EmptyState
			body="Coverage will be listed here."
			headingLevel="h2"
			title="No coverage yet"
		/>
	);
	expect(html).toMatch(/<h2[^>]*>No coverage yet<\/h2>/);
	expect(html).not.toContain("<a");
	expect(html).not.toContain("aria-hidden");
});

// apps/web/src/public-pages.css sets `border-width: 0` on every content
// section, article, aside or div without a `data-slot`, so a ruled or outlined
// div must carry one or its rule disappears on the marketing site.
const UNSLOTTED_BORDERED_DIV =
	/<(?:div|section|article|aside)(?![^>]*data-slot=)[^>]*class="[^"]*\bborder(?:-[tbxylr])?\b[^"]*"/;

test("ruled and outlined primitives keep their borders on public pages", () => {
	const factSheet = renderToStaticMarkup(<FactSheet facts={FACTS} />);
	expect(factSheet).toContain('data-slot="fact-sheet-row"');
	expect(factSheet).not.toMatch(UNSLOTTED_BORDERED_DIV);
	const empty = renderToStaticMarkup(
		<EmptyState body="Nothing listed yet." title="No events" />
	);
	expect(empty).toContain('data-slot="empty-state"');
	expect(empty).not.toMatch(UNSLOTTED_BORDERED_DIV);
	const dated = renderToStaticMarkup(
		<DatedList emptyState={<p>None</p>} items={ITEMS} title="Releases" />
	);
	expect(dated).not.toMatch(UNSLOTTED_BORDERED_DIV);
});
