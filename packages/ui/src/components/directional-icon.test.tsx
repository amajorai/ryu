import { describe, expect, test } from "bun:test";
import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { renderToStaticMarkup } from "react-dom/server";
import { BreadcrumbSeparator } from "./breadcrumb.tsx";
import {
	DIRECTIONAL_ICON_CLASS,
	DirectionalIcon,
} from "./directional-icon.tsx";
import { TabsOverflowNavigation } from "./tabs-overflow-navigation.tsx";

describe("DirectionalIcon", () => {
	test("mirrors only under rtl and keeps caller classes", () => {
		const html = renderToStaticMarkup(
			<DirectionalIcon className="size-4" icon={ArrowRight01Icon} />
		);
		expect(DIRECTIONAL_ICON_CLASS).toBe("rtl:-scale-x-100");
		expect(html).toContain("rtl:-scale-x-100");
		expect(html).toContain("size-4");
		expect(html).toContain("<svg");
	});

	test("the default breadcrumb separator mirrors; custom children are left alone", () => {
		expect(renderToStaticMarkup(<BreadcrumbSeparator />)).toContain(
			"rtl:-scale-x-100"
		);
		expect(
			renderToStaticMarkup(<BreadcrumbSeparator>/</BreadcrumbSeparator>)
		).not.toContain("rtl:-scale-x-100");
	});
});

describe("TabsOverflowNavigation", () => {
	test("each physical button names the side it scrolls toward and points outward", () => {
		const html = renderToStaticMarkup(
			<div dir="rtl">
				<TabsOverflowNavigation
					edges={{ end: true, start: true }}
					listId="tabs"
					onScrollPage={() => undefined}
				>
					<div />
				</TabsOverflowNavigation>
			</div>
		);
		const left = html.match(
			/<button[^>]*aria-label="Scroll tabs left"[^>]*>/
		)?.[0];
		const right = html.match(
			/<button[^>]*aria-label="Scroll tabs right"[^>]*>/
		)?.[0];
		expect(left).toContain(" left-0 ");
		expect(right).toContain(" right-0 ");
		expect(html).toContain('aria-label="Tab scrolling controls"');
		// Physical buttons keep physical glyphs: no mirroring here.
		expect(html).not.toContain("rtl:-scale-x-100");
	});
});
