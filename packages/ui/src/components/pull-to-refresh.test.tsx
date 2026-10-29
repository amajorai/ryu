import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PullToRefresh } from "./pull-to-refresh.tsx";

// `scroll-fade` drives its mask from `animation-timeline: scroll(self y)`, so
// it only works on the element that scrolls: PullToRefresh's own root.
const SCROLLER = /<div aria-label="Pull to refresh" class="([^"]*)"/;

describe("PullToRefresh edge fade", () => {
	test("puts scroll-fade on the scrolling root when edgeFade is set", () => {
		const html = renderToStaticMarkup(
			<PullToRefresh edgeFade onRefresh={() => undefined}>
				Content
			</PullToRefresh>
		);
		const classes = html.match(SCROLLER)?.[1] ?? "";
		expect(classes).toContain("overflow-y-auto");
		expect(classes.split(" ")).toContain("scroll-fade");
	});

	test("leaves the scroller unmasked by default", () => {
		const html = renderToStaticMarkup(
			<PullToRefresh onRefresh={() => undefined}>Content</PullToRefresh>
		);
		const classes = html.match(SCROLLER)?.[1] ?? "";
		expect(classes).toContain("overflow-y-auto");
		expect(classes.split(" ")).not.toContain("scroll-fade");
	});
});

describe("PullToRefresh non-gesture alternative", () => {
	test("renders a real refresh button alongside the pull gesture", () => {
		const html = renderToStaticMarkup(
			<PullToRefresh onRefresh={() => undefined}>Content</PullToRefresh>
		);
		expect(html).toContain('<button class="');
		expect(html).toContain('type="button">Refresh list</button>');
	});

	test("names the button from refreshLabel", () => {
		const html = renderToStaticMarkup(
			<PullToRefresh onRefresh={() => undefined} refreshLabel="Refresh tray">
				Content
			</PullToRefresh>
		);
		expect(html).toContain(">Refresh tray</button>");
	});
});
