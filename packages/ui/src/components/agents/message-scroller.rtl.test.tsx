import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PreviewRail } from "../motion/preview-rail.tsx";
import { MessageScroller } from "./message-scroller.tsx";
import { CollapsedMessageRail } from "./message-scroller-rail.tsx";

// The transcript's turn-navigation rail and its hover previews sit on the
// inline start and open toward the inline end, so under a right-to-left
// language they mirror with the rest of the chat instead of staying pinned to
// the physical left.
const PHYSICAL_INLINE = /(?:^|\s)(?:-?(?:left|right)-|m[lr]-|p[lr]-)/u;

function classesOf(html: string, tag: string, marker: string): string {
	const pattern = new RegExp(`<${tag}[^>]*class="([^"]*${marker}[^"]*)"`, "u");
	const match = html.match(pattern);
	if (!match?.[1]) {
		throw new Error(`No <${tag}> with ${marker}`);
	}
	return match[1];
}

describe("message rail under right-to-left", () => {
	test("pins the rail and its preview column to logical edges", () => {
		const html = renderToStaticMarkup(
			<div dir="rtl">
				<MessageScroller
					navigation="rail"
					railItems={[
						{ id: "a", label: "First" },
						{ id: "b", label: "Second" },
					]}
				>
					<p>Hello</p>
				</MessageScroller>
			</div>
		);
		const rail = classesOf(html, "nav", "inset-y-3");
		expect(rail.split(" ")).toContain("start-1");
		expect(rail).not.toMatch(PHYSICAL_INLINE);
		const previews = classesOf(html, "div", "z-50 grid");
		expect(previews.split(" ")).toEqual(
			expect.arrayContaining(["end-3", "start-8"])
		);
		expect(previews).not.toMatch(PHYSICAL_INLINE);
	});

	test("the collapsed rail stays on the inline start like the expanded one", () => {
		const html = renderToStaticMarkup(
			<div dir="rtl">
				<CollapsedMessageRail
					activeId="a"
					items={[
						{ id: "a", label: "First" },
						{ id: "b", label: "Second" },
					]}
					onItemSelect={() => undefined}
				/>
			</div>
		);
		const trigger = classesOf(html, "button", "top-1/2");
		expect(trigger.split(" ")).toContain("start-1");
		expect(trigger).not.toMatch(PHYSICAL_INLINE);
	});

	test("the shared preview rail uses logical insets on either side", () => {
		for (const [previewSide, inset] of [
			["before", ["end-16", "start-4"]],
			["after", ["end-4", "start-16"]],
		] as const) {
			const html = renderToStaticMarkup(
				<PreviewRail
					items={[{ id: "a", label: "First" }]}
					label="Turns"
					previewSide={previewSide}
				/>
			);
			const previews = classesOf(html, "div", "z-50 grid");
			expect(previews.split(" ")).toEqual(expect.arrayContaining(inset));
			expect(previews).not.toMatch(PHYSICAL_INLINE);
		}
	});
});
