import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PageHeader } from "./page-header.tsx";
import { SidebarGroupLabel } from "./sidebar-sections.tsx";

// `cn` reads an unregistered `text-*` class such as `text-detail` as a text
// colour, so a later `text-muted-foreground` silently drops it. The detail
// size must survive the merge as the length form.
test("the app page header keeps its detail-size subtitle through cn", () => {
	const html = renderToStaticMarkup(
		<PageHeader size="app" subtitle="One line" title="Library" />
	);
	expect(html).toContain("text-(length:--text-detail)");
	expect(html).toContain("leading-(--text-detail--line-height)");
	expect(html).toContain("text-muted-foreground");
	expect(html).not.toContain("t-stagger-line");
});

test("the sidebar group label keeps its detail size through cn", () => {
	const html = renderToStaticMarkup(
		<SidebarGroupLabel>Agents</SidebarGroupLabel>
	);
	expect(html).toContain("text-(length:--text-detail)");
	expect(html).toContain("text-muted-foreground");
});
