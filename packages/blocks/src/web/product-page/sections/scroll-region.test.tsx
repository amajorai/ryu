import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ProductComparisonTable } from "./comparison-table.tsx";
import { SCROLL_FADE_CLASS, ScrollRegion } from "./scroll-region.tsx";

const html = renderToStaticMarkup(
	<ScrollRegion className="hidden md:block" label="Plans compared">
		<table>
			<tbody>
				<tr>
					<td>Cell</td>
				</tr>
			</tbody>
		</table>
	</ScrollRegion>
);

test("the scroll frame is a named, keyboard-focusable region with a ring", () => {
	const frame = html.match(/<div [^>]*role="region"[^>]*>/)?.[0] ?? "";
	expect(frame).toContain('aria-label="Plans compared"');
	expect(frame).toContain('tabindex="0"');
	expect(frame).toContain("overflow-x-auto");
	expect(frame).toContain("focus-visible:ring-2");
	// sr-only cell labels position against the frame, so they stay inside it.
	expect(frame).toMatch(/class="relative /);
	expect(html).toContain(`${frame}<table>`);
});

test("a decorative inline-end fade hints at more columns below md only", () => {
	const fade = html.match(/<div [^>]*data-scroll-fade=""[^>]*>/)?.[0] ?? "";
	expect(fade).toContain('aria-hidden="true"');
	for (const token of [
		"pointer-events-none",
		"-end-6",
		"rtl:bg-linear-to-r",
		"from-background",
		"md:hidden",
	]) {
		expect(SCROLL_FADE_CLASS).toContain(token);
		expect(fade).toContain(token);
	}
	// The fade sits after the frame, outside the scrolling content.
	expect(html.indexOf("data-scroll-fade")).toBeGreaterThan(
		html.indexOf("</table>")
	);
});

test("the outer wrapper takes the caller's classes", () => {
	expect(html).toMatch(
		/^<div class="relative hidden md:block" data-scroll-region="">/
	);
});

test("the shared comparison table scrolls inside the region, with the fade", () => {
	const table = renderToStaticMarkup(
		<ProductComparisonTable
			comparison={{
				columns: ["Self-hosted", "Managed"],
				rows: [{ label: "Runs on", values: ["Your server", "Ryu Cloud"] }],
				source: { path: "README.md" },
				title: "Where it runs",
			}}
		/>
	);
	expect(table).toMatch(
		/role="region"[^>]*tabindex="0"|tabindex="0"[^>]*role="region"/
	);
	expect(table).toContain('aria-label="Where it runs"');
	expect(table).toContain('data-scroll-fade=""');
});
